/**
 * Read prompt overrides from the shared GCS file managed by Hamlet.
 *
 * Hamlet's Prompts admin UI writes overrides to
 * gs://tiktok-im-hamlet-state/hamlet/prompts.json. Junior reads them
 * with a 30s in-memory cache so edits propagate quickly.
 *
 * If a prompt id has no override, the caller's hardcoded fallback is used.
 */

const STATE_BUCKET = 'tiktok-im-hamlet-state';
const PROMPTS_PATH = 'hamlet/prompts.json';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const CACHE_TTL_MS = 30 * 1000;

interface CachedToken { token: string; expiresAt: number }
let cachedToken: CachedToken | null = null;

async function getMetadataToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;
  const res = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('metadata token missing access_token');
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

interface PromptOverride { content: string; updatedAt: string; updatedBy?: string }
type PromptOverrides = Record<string, PromptOverride>;

let memCache: { data: PromptOverrides; fetchedAt: number } | null = null;

async function loadOverrides(): Promise<PromptOverrides> {
  if (memCache && Date.now() - memCache.fetchedAt < CACHE_TTL_MS) return memCache.data;
  try {
    const token = await getMetadataToken();
    const url = `https://storage.googleapis.com/storage/v1/b/${STATE_BUCKET}/o/${encodeURIComponent(PROMPTS_PATH)}?alt=media`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      memCache = { data: {}, fetchedAt: Date.now() };
      return memCache.data;
    }
    const data = await res.json() as PromptOverrides;
    memCache = { data: data ?? {}, fetchedAt: Date.now() };
  } catch {
    memCache = { data: {}, fetchedAt: Date.now() };
  }
  return memCache.data;
}

/**
 * Get a prompt by ID. Returns the override from GCS if set, otherwise
 * the fallback (the hardcoded default in Junior's code).
 */
export async function getPrompt(id: string, fallback: string): Promise<string> {
  const overrides = await loadOverrides();
  return overrides[id]?.content ?? fallback;
}

/**
 * Substitute ${var} placeholders in a prompt template.
 */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}
