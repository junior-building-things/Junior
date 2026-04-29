import { ChatMessage } from './types';

const MAX_HISTORY = 30;

// Junior keeps two parallel conversation logs in GCS:
//   - Chat-level   junior/chat-history/<chatId>.json
//       Everything said in this chat by everyone. Gives Junior the
//       collaborative thread continuity ("and the figma?" works even
//       if a colleague just asked about the AB report).
//   - User-level   junior/user-history/<openId>.json
//       Everything THIS user has said to Junior across all chats.
//       Gives Junior personal continuity (your follow-up Q in chat Y
//       still has context from your chat-X turn yesterday).
// At read time we merge the two streams by timestamp, dedup by
// (ts, role), and cap to MAX_HISTORY. At write time we append the new
// turn to both files.
//
// A short in-memory cache (per Cloud Run instance) avoids hitting GCS
// twice for fast follow-up turns.

const HISTORY_BUCKET = 'tiktok-im-hamlet-state';
const CHAT_PREFIX = 'junior/chat-history/';
const USER_PREFIX = 'junior/user-history/';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const HISTORY_CACHE_TTL_MS = 60_000;

interface CachedToken { token: string; expiresAt: number }
let cachedGcsToken: CachedToken | null = null;

async function getGcsToken(): Promise<string> {
  if (cachedGcsToken && Date.now() < cachedGcsToken.expiresAt - 60_000) return cachedGcsToken.token;
  const res = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('metadata token missing access_token');
  cachedGcsToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedGcsToken.token;
}

interface CachedHistory { data: ChatMessage[]; fetchedAt: number }
const historyCache = new Map<string, CachedHistory>();

function chatPath(chatId: string): string {
  return `${CHAT_PREFIX}${encodeURIComponent(chatId)}.json`;
}
function userPath(openId: string): string {
  return `${USER_PREFIX}${encodeURIComponent(openId)}.json`;
}

async function loadHistoryFile(path: string): Promise<ChatMessage[]> {
  const cached = historyCache.get(path);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) return cached.data;
  let data: ChatMessage[] = [];
  try {
    const token = await getGcsToken();
    const url = `https://storage.googleapis.com/storage/v1/b/${HISTORY_BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const parsed = await res.json() as unknown;
      if (Array.isArray(parsed)) data = parsed as ChatMessage[];
    } else if (res.status !== 404) {
      console.warn(`[store] load ${path} failed: ${res.status}`);
    }
  } catch (e) {
    console.warn(`[store] load ${path} threw:`, e);
  }
  historyCache.set(path, { data, fetchedAt: Date.now() });
  return data;
}

async function saveHistoryFile(path: string, messages: ChatMessage[]): Promise<void> {
  const trimmed = messages.slice(-MAX_HISTORY);
  historyCache.set(path, { data: trimmed, fetchedAt: Date.now() });
  try {
    const token = await getGcsToken();
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${HISTORY_BUCKET}/o?uploadType=media&name=${encodeURIComponent(path)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(trimmed),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[store] save ${path} failed: ${res.status} ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`[store] save ${path} threw:`, e);
  }
}

/**
 * Read the chat-level history (everything said in this chat by anyone).
 */
export async function loadChatHistory(chatId: string): Promise<ChatMessage[]> {
  return loadHistoryFile(chatPath(chatId));
}

/**
 * Read the user-level history (everything this user said to Junior
 * across all chats). Returns [] if openId is missing.
 */
export async function loadUserHistory(openId: string): Promise<ChatMessage[]> {
  if (!openId) return [];
  return loadHistoryFile(userPath(openId));
}

/**
 * Load chat-level + user-level history, merge by timestamp, dedup, and
 * cap to MAX_HISTORY. The merged stream is what we hand to Gemini as
 * conversation history.
 */
export async function loadMergedHistory(
  chatId: string,
  openId?: string,
): Promise<ChatMessage[]> {
  const [chat, user] = await Promise.all([
    loadChatHistory(chatId),
    openId ? loadUserHistory(openId) : Promise.resolve<ChatMessage[]>([]),
  ]);
  if (user.length === 0) return chat.slice(-MAX_HISTORY);
  const seen = new Set<string>();
  const all = [...chat, ...user];
  // Older first. Messages without ts (legacy) keep their array order
  // by sorting them to the front with a sentinel value.
  all.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const merged: ChatMessage[] = [];
  for (const m of all) {
    // Dedup key: same message saved to both files has the same ts +
    // role + content prefix. Legacy messages without ts won't dedup
    // (they were chat-only anyway).
    const key = m.ts != null
      ? `${m.ts}|${m.role}`
      : `legacy|${m.role}|${m.content.slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(m);
  }
  return merged.slice(-MAX_HISTORY);
}

/**
 * Persist a single user→model turn. Appends to BOTH the chat file and
 * the user file in parallel (each independently trimmed to MAX_HISTORY).
 */
export async function appendTurn(
  chatId: string,
  senderOpenId: string,
  userText: string,
  modelText: string,
): Promise<void> {
  const now = Date.now();
  const userMsg: ChatMessage = { role: 'user', content: userText, ts: now, chatId, senderOpenId };
  const modelMsg: ChatMessage = { role: 'model', content: modelText, ts: now + 1, chatId };

  const tasks: Promise<void>[] = [];
  // Chat file (always).
  tasks.push((async () => {
    const cur = await loadHistoryFile(chatPath(chatId));
    cur.push(userMsg, modelMsg);
    await saveHistoryFile(chatPath(chatId), cur);
  })());
  // User file (only if we have an open_id).
  if (senderOpenId) {
    tasks.push((async () => {
      const cur = await loadHistoryFile(userPath(senderOpenId));
      cur.push(userMsg, modelMsg);
      await saveHistoryFile(userPath(senderOpenId), cur);
    })());
  }
  await Promise.all(tasks);
}

/**
 * Wipe a single chat's history.
 */
export async function clearChatHistory(chatId: string): Promise<void> {
  await saveHistoryFile(chatPath(chatId), []);
}

/**
 * Wipe a single user's cross-chat history.
 */
export async function clearUserHistory(openId: string): Promise<void> {
  if (!openId) return;
  await saveHistoryFile(userPath(openId), []);
}

// ─── Back-compat exports (for callers not yet migrated) ─────────────────────
export const loadMessages = loadChatHistory;
export async function saveMessages(chatId: string, messages: ChatMessage[]): Promise<void> {
  await saveHistoryFile(chatPath(chatId), messages);
}

// Legacy KV path for the dedup helper below — kept until we migrate
// dedup off too. Not used for chat history.
let kv: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<unknown> } | null = null;
async function getKv() {
  if (kv) return kv;
  if (process.env.KV_REST_API_URL) {
    try {
      const mod = await import('@vercel/kv');
      kv = mod.kv;
      return kv;
    } catch { /* fall through */ }
  }
  return null;
}

// Deduplication — persisted via GCS, with in-memory cache to reduce latency
const processedEvents = new Set<string>();
const GCS_BUCKET = process.env.GCS_DEDUP_BUCKET;
const GCS_OBJECT = 'dedup/processed-events.json';
let gcsLoaded = false;

async function loadDedupFromGcs(): Promise<void> {
  if (gcsLoaded || !GCS_BUCKET) return;
  gcsLoaded = true;
  try {
    const { Storage } = await import('@google-cloud/storage');
    const file = new Storage().bucket(GCS_BUCKET).file(GCS_OBJECT);
    const [exists] = await file.exists();
    if (!exists) return;
    const [contents] = await file.download();
    const ids = JSON.parse(contents.toString()) as string[];
    for (const id of ids) processedEvents.add(id);
    console.log(`[dedup] Loaded ${ids.length} processed events from GCS`);
  } catch (e) {
    console.error('[dedup] GCS load failed:', e);
  }
}

async function saveDedupToGcs(): Promise<void> {
  if (!GCS_BUCKET) return;
  try {
    const { Storage } = await import('@google-cloud/storage');
    const file = new Storage().bucket(GCS_BUCKET).file(GCS_OBJECT);
    const ids = [...processedEvents];
    // Keep only the most recent 10k to bound object size
    const trimmed = ids.slice(-10_000);
    await file.save(JSON.stringify(trimmed), { contentType: 'application/json' });
  } catch (e) {
    console.error('[dedup] GCS save failed:', e);
  }
}

export async function recordEventOnce(eventId: string): Promise<boolean> {
  if (!eventId) return true;

  // Prefer Vercel KV if configured (legacy path)
  const store = await getKv();
  if (store) {
    const key = `evt:${eventId}`;
    const existing = await store.get(key);
    if (existing) return false;
    await store.set(key, 1);
    return true;
  }

  // Otherwise use GCS-backed in-memory set
  await loadDedupFromGcs();

  if (processedEvents.has(eventId)) return false;
  processedEvents.add(eventId);
  if (processedEvents.size > 10000) {
    const first = processedEvents.values().next().value;
    if (first) processedEvents.delete(first);
  }
  // Fire-and-forget persistence (don't block caller)
  saveDedupToGcs().catch(() => {});
  return true;
}
