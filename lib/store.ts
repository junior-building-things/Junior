import { ChatMessage } from './types';

const MAX_HISTORY = 30;

// Try Vercel KV, fall back to in-memory Map
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

// In-memory fallback for local dev
const memStore = new Map<string, ChatMessage[]>();

export async function loadMessages(chatId: string): Promise<ChatMessage[]> {
  const store = await getKv();
  if (store) {
    const data = await store.get(`chat:${chatId}`);
    return (Array.isArray(data) ? data : []) as ChatMessage[];
  }
  return memStore.get(chatId) ?? [];
}

export async function saveMessages(chatId: string, messages: ChatMessage[]): Promise<void> {
  const trimmed = messages.slice(-MAX_HISTORY);
  const store = await getKv();
  if (store) {
    await store.set(`chat:${chatId}`, trimmed);
    return;
  }
  memStore.set(chatId, trimmed);
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
