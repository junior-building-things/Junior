import { ChatMessage } from './types';

const MAX_HISTORY = 30;

// Per-chat conversation history is persisted in GCS so it survives
// Cloud Run cold starts, instance churn, and deploys. One JSON object
// per chatId at junior/chat-history/<chatId>.json in the shared
// hamlet-state bucket. A short in-memory cache (per process) avoids
// the GCS round-trip for fast follow-up turns.

const HISTORY_BUCKET = 'tiktok-im-hamlet-state';
const HISTORY_PREFIX = 'junior/chat-history/';
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

function historyObjectName(chatId: string): string {
  // chatId is a Lark oc_… string; safe enough as a path component but
  // encode anyway in case of unexpected characters.
  return `${HISTORY_PREFIX}${encodeURIComponent(chatId)}.json`;
}

export async function loadMessages(chatId: string): Promise<ChatMessage[]> {
  const cached = historyCache.get(chatId);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) return cached.data;
  let data: ChatMessage[] = [];
  try {
    const token = await getGcsToken();
    const url = `https://storage.googleapis.com/storage/v1/b/${HISTORY_BUCKET}/o/${encodeURIComponent(historyObjectName(chatId))}?alt=media`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const parsed = await res.json() as unknown;
      if (Array.isArray(parsed)) data = parsed as ChatMessage[];
    } else if (res.status !== 404) {
      console.warn(`[store] loadMessages ${chatId} failed: ${res.status}`);
    }
  } catch (e) {
    console.warn(`[store] loadMessages ${chatId} threw:`, e);
  }
  historyCache.set(chatId, { data, fetchedAt: Date.now() });
  return data;
}

export async function saveMessages(chatId: string, messages: ChatMessage[]): Promise<void> {
  const trimmed = messages.slice(-MAX_HISTORY);
  // Update in-memory cache immediately so the next read on the same
  // instance gets the fresh history without waiting for GCS.
  historyCache.set(chatId, { data: trimmed, fetchedAt: Date.now() });
  try {
    const token = await getGcsToken();
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${HISTORY_BUCKET}/o?uploadType=media&name=${encodeURIComponent(historyObjectName(chatId))}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(trimmed),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[store] saveMessages ${chatId} failed: ${res.status} ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`[store] saveMessages ${chatId} threw:`, e);
  }
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
