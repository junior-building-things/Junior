/**
 * Read the Hamlet feature cache from GCS.
 *
 * Hamlet stores enriched feature data (status, risk, version, links, team,
 * notes) at gs://tiktok-im-hamlet-state/hamlet/features.json. This module
 * lets Junior read it for instant answers without calling Meego.
 */

const STATE_BUCKET = 'tiktok-im-hamlet-state';
const FEATURES_PATH = 'hamlet/features.json';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

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

export interface HamletFeature {
  id: string;
  name: string;
  status: string;
  priority: string;
  owner: string;
  meegoUrl?: string;
  prd?: string;
  figmaUrl?: string;
  complianceUrl?: string;
  abReportUrl?: string;
  libraUrl?: string;
  iosVersion?: string;
  versionHistory?: string[];
  riskLevel?: string;
  riskNotes?: string[];
  /**
   * Planned-version / launch-date slips detected by Hamlet's digest.
   * Each entry is `{date: 'YYYY-MM-DD', from, to}`. When non-empty the
   * feature is "Delayed" — even when riskLevel is null (Hamlet
   * suppresses riskLevel for AB Testing but keeps versionChanges so
   * the Delayed badge still renders). Junior should treat this as
   * the effective risk.
   */
  versionChanges?: Array<{ date: string; from: string; to: string }>;
  pmOwner?: string;
  techOwner?: string;
  iosOwner?: string;
  androidOwner?: string;
  serverOwner?: string;
  qaOwner?: string;
  uiuxOwner?: string;
  daOwner?: string;
  contentDesigner?: string;
  businessLine?: string;
  quarterlyCycle?: string;
  lastUpdated?: string;
  chatId?: string;
  pocEmails?: Record<string, string>;  // name → email for @mentions
  meegoIssueId?: string;
  manualEdits?: string[];
  /** Latest page of comments on the Meego ticket itself. Synced by Hamlet. */
  meegoComments?: Array<{ author: string; content: string; createdAt: string }>;
}

interface FeatureCache {
  updatedAt: string;
  features: HamletFeature[];
}

let memCache: { data: FeatureCache; fetchedAt: number } | null = null;
const MEM_CACHE_TTL = 5 * 60 * 1000; // 5 min in-memory cache

/**
 * Load all features from the Hamlet GCS cache. Cached in memory for 5 min
 * to avoid repeated GCS reads within the same request burst.
 */
export async function loadHamletFeatures(): Promise<HamletFeature[]> {
  if (memCache && Date.now() - memCache.fetchedAt < MEM_CACHE_TTL) {
    return memCache.data.features;
  }
  const token = await getMetadataToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${STATE_BUCKET}/o/${encodeURIComponent(FEATURES_PATH)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GCS read failed: ${res.status}`);
  const data = await res.json() as FeatureCache;
  memCache = { data, fetchedAt: Date.now() };
  return data.features;
}

/**
 * Search for a feature by name (fuzzy keyword match). Prefers ongoing
 * features over Done ones.
 */
export function findFeature(features: HamletFeature[], query: string): HamletFeature | undefined {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return undefined;
  let best: HamletFeature | undefined;
  let bestScore = 0;
  for (const f of features) {
    const nameLower = f.name.toLowerCase();
    let score = words.filter(w => nameLower.includes(w)).length;
    if (f.status !== 'Done' && f.status !== '已完成') score += 0.5;
    if (score > bestScore && score >= Math.min(2, words.length)) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

/**
 * Format a feature into a readable string for Gemini to use in its response.
 */
export function formatFeature(f: HamletFeature): string {
  // Annotate owner names with their email for @mention lookup.
  // Gemini should render these as <at email=xxx></at> tags.
  const withEmail = (name?: string): string => {
    if (!name) return '';
    const firstName = name.split(',')[0]?.trim();
    const email = firstName ? f.pocEmails?.[firstName] : undefined;
    return email ? `${name} [email=${email}]` : name;
  };

  const lines: string[] = [`Feature: ${f.name}`];
  if (f.status)          lines.push(`Status: ${f.status}`);
  if (f.priority)        lines.push(`Priority: ${f.priority}`);
  if (f.iosVersion)      lines.push(`Version: ${f.iosVersion}`);
  if (f.versionHistory?.length) lines.push(`Version History: ${f.versionHistory.join(' → ')}`);
  // Risk: prefer the explicit Delayed signal (versionChanges) over
  // riskLevel — Hamlet suppresses riskLevel for AB Testing features
  // but keeps versionChanges populated as the Delayed indicator. List
  // every slip in the tooltip-style "M/D: from → to" format.
  const isDelayed = (f.versionChanges?.length ?? 0) > 0;
  if (isDelayed) {
    const summary = f.versionChanges!
      .map(c => {
        const [, mm, dd] = c.date.split('-');
        const short = (mm && dd) ? `${parseInt(mm, 10)}/${parseInt(dd, 10)}: ` : '';
        return `${short}${c.from} → ${c.to}`;
      })
      .join('; ');
    lines.push(`Risk: Delayed (${summary})`);
  } else if (f.riskLevel) {
    lines.push(`Risk: ${f.riskLevel === 'red' ? 'High' : f.riskLevel === 'yellow' ? 'Medium' : 'Low'}`);
  }
  if (f.riskNotes?.length) lines.push(`Risk Notes: ${f.riskNotes.join(', ')}`);
  if (f.owner)           lines.push(`Owner: ${withEmail(f.owner)}`);
  if (f.pmOwner)         lines.push(`PM: ${withEmail(f.pmOwner)}`);
  if (f.techOwner)       lines.push(`Tech Owner: ${withEmail(f.techOwner)}`);
  if (f.iosOwner)        lines.push(`iOS: ${withEmail(f.iosOwner)}`);
  if (f.androidOwner)    lines.push(`Android: ${withEmail(f.androidOwner)}`);
  if (f.serverOwner)     lines.push(`Server: ${withEmail(f.serverOwner)}`);
  if (f.qaOwner)         lines.push(`QA: ${withEmail(f.qaOwner)}`);
  if (f.uiuxOwner)       lines.push(`UX: ${withEmail(f.uiuxOwner)}`);
  if (f.daOwner)         lines.push(`DS: ${withEmail(f.daOwner)}`);
  if (f.contentDesigner) lines.push(`Content Designer: ${withEmail(f.contentDesigner)}`);
  if (f.prd)             lines.push(`PRD: ${f.prd}`);
  if (f.figmaUrl)        lines.push(`Figma: ${f.figmaUrl}`);
  if (f.meegoUrl)        lines.push(`Meego: ${f.meegoUrl}`);
  if (f.complianceUrl)   lines.push(`Compliance: ${f.complianceUrl}`);
  if (f.abReportUrl)     lines.push(`AB Report: ${f.abReportUrl}`);
  if (f.libraUrl)        lines.push(`Libra: ${f.libraUrl}`);
  if (f.businessLine)    lines.push(`Business Line: ${f.businessLine}`);
  if (f.lastUpdated)     lines.push(`Last Updated: ${f.lastUpdated}`);
  if (f.meegoComments?.length) {
    lines.push('');
    lines.push(`Meego Comments (latest ${f.meegoComments.length}):`);
    for (const c of f.meegoComments) {
      const date = c.createdAt ? `${c.createdAt} ` : '';
      const who = c.author ? `${c.author}: ` : '';
      // Cap each comment to ~280 chars to avoid bloating the prompt.
      const body = c.content.length > 280 ? `${c.content.slice(0, 280)}…` : c.content;
      lines.push(`  - ${date}${who}${body}`);
    }
  }
  return lines.join('\n');
}

/**
 * Update a single feature's link in the Hamlet GCS cache and add the field
 * to manualEdits[] so it's protected from sync overwrites. Uses GCS optimistic
 * concurrency (if-match generation header) to avoid races.
 */
export async function updateFeatureLink(
  featureId: string,
  field: 'figmaUrl' | 'libraUrl' | 'abReportUrl',
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = await getMetadataToken();
  // Read current cache + generation
  const readUrl = `https://storage.googleapis.com/storage/v1/b/${STATE_BUCKET}/o/${encodeURIComponent(FEATURES_PATH)}?alt=media`;
  const readRes = await fetch(readUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!readRes.ok) return { ok: false, error: `GCS read failed: ${readRes.status}` };
  const generation = readRes.headers.get('x-goog-generation') ?? '';
  const cache = await readRes.json() as FeatureCache;

  const idx = cache.features.findIndex(f => f.id === featureId || f.meegoIssueId === featureId);
  if (idx === -1) return { ok: false, error: 'feature not found in cache' };

  const feat = cache.features[idx];
  const manualEdits = new Set(feat.manualEdits ?? []);
  manualEdits.add(field);
  cache.features[idx] = { ...feat, [field]: url, manualEdits: [...manualEdits] };
  cache.updatedAt = new Date().toISOString();

  // Write with generation precondition
  const writeUrl = `https://storage.googleapis.com/upload/storage/v1/b/${STATE_BUCKET}/o?uploadType=media&name=${encodeURIComponent(FEATURES_PATH)}${generation ? `&ifGenerationMatch=${generation}` : ''}`;
  const writeRes = await fetch(writeUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cache),
  });
  if (!writeRes.ok) {
    const text = await writeRes.text();
    return { ok: false, error: `GCS write failed: ${writeRes.status} ${text.slice(0, 200)}` };
  }
  // Invalidate in-memory cache so next read gets the fresh data
  memCache = null;
  return { ok: true };
}
