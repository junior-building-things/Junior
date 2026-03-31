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

// Deduplication
const processedEvents = new Set<string>();

export async function recordEventOnce(eventId: string): Promise<boolean> {
  if (!eventId) return true;
  const store = await getKv();
  if (store) {
    const key = `evt:${eventId}`;
    const existing = await store.get(key);
    if (existing) return false;
    await store.set(key, 1);
    return true;
  }
  if (processedEvents.has(eventId)) return false;
  processedEvents.add(eventId);
  // Prevent memory leak in dev
  if (processedEvents.size > 10000) {
    const first = processedEvents.values().next().value;
    if (first) processedEvents.delete(first);
  }
  return true;
}
