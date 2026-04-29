/**
 * Junior context files — markdown documents that get appended to the
 * system prompt at chat time. Source of truth lives in
 * `gs://tiktok-im-hamlet-state/junior/context/<name>.md`. Hamlet's UI
 * provides editing; Junior just reads.
 *
 * Files are cached in-process for 60s so a normal turn doesn't pay
 * the GCS round trip. The remember_preference tool invalidates the
 * cache locally after a write so the change is reflected on the next
 * turn from the same instance.
 */

const STATE_BUCKET = 'tiktok-im-hamlet-state';
const PREFIX = 'junior/context/';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const CACHE_TTL_MS = 60_000;

interface CachedToken { token: string; expiresAt: number }
let cachedToken: CachedToken | null = null;

async function getGcsToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;
  const res = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('metadata token missing access_token');
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

export interface ContextFile { name: string; content: string }

interface CachedFiles { data: ContextFile[]; fetchedAt: number }
let cached: CachedFiles | null = null;

async function listObjectNames(): Promise<string[]> {
  const token = await getGcsToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${STATE_BUCKET}/o?prefix=${encodeURIComponent(PREFIX)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    if (res.status === 404) return [];
    console.warn(`[context] list failed: ${res.status}`);
    return [];
  }
  const data = await res.json() as { items?: Array<{ name: string }> };
  return (data.items ?? []).map(i => i.name).filter(n => n && !n.endsWith('/'));
}

async function readObject(name: string): Promise<string | null> {
  const token = await getGcsToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${STATE_BUCKET}/o/${encodeURIComponent(name)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`[context] read ${name} failed: ${res.status}`);
    return null;
  }
  return await res.text();
}

async function writeObject(name: string, content: string): Promise<boolean> {
  const token = await getGcsToken();
  const params = new URLSearchParams({ uploadType: 'media', name });
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${STATE_BUCKET}/o?${params.toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/markdown; charset=utf-8' },
    body: content,
  });
  if (!res.ok) {
    console.warn(`[context] write ${name} failed: ${res.status}`);
    return false;
  }
  return true;
}

/**
 * Load every .md context file. Cached for 60s per instance.
 */
export async function loadAllContextFiles(): Promise<ContextFile[]> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  const names = await listObjectNames();
  const files: ContextFile[] = [];
  await Promise.all(
    names.map(async fullName => {
      const text = await readObject(fullName);
      if (text != null) {
        files.push({ name: fullName.slice(PREFIX.length), content: text });
      }
    }),
  );
  // Stable ordering so the system prompt doesn't churn.
  files.sort((a, b) => a.name.localeCompare(b.name));
  cached = { data: files, fetchedAt: Date.now() };
  return files;
}

/**
 * Build a single string suitable for appending to the model's
 * systemInstruction. Each file is rendered with a heading so the model
 * can tell them apart.
 */
export async function buildContextBlock(): Promise<string> {
  const files = await loadAllContextFiles();
  if (files.length === 0) return '';
  const parts: string[] = ['', '═══ ADDITIONAL CONTEXT ═══'];
  for (const f of files) {
    parts.push('', `── ${f.name} ──`, f.content.trim());
  }
  return parts.join('\n');
}

/**
 * Append text to a context file (creating it if missing). Used by the
 * remember_preference tool. Invalidates the local cache so the next
 * turn sees the new line.
 */
export async function appendToContextFile(name: string, addition: string): Promise<boolean> {
  const fullName = PREFIX + name;
  const existing = (await readObject(fullName)) ?? '';
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const next = existing + sep + addition + (addition.endsWith('\n') ? '' : '\n');
  const ok = await writeObject(fullName, next);
  if (ok) cached = null;
  return ok;
}

export function invalidateContextCache(): void {
  cached = null;
}
