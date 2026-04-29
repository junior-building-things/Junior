/**
 * Helpers for the real-time PRD comment follow-up flow.
 *
 * - readJuniorCommentThread: look up state.juniorCommentThreads
 *   (saved in lib/letjr.ts after a successful PRD comment reply).
 * - fetchCommentReply: call Lark drive comments API to retrieve a
 *   specific reply's text + the open_ids it mentions, so the webhook
 *   handler can decide whether Junior was tagged.
 */

const STATE_BUCKET = 'tiktok-im-hamlet-state';
const STATE_PATH = 'digests/chat-risks.json';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const LARK_BASE_URL = 'https://open.larksuite.com';

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

async function getLarkBotToken(): Promise<string> {
  const res = await fetch(`${LARK_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }),
  });
  const data = await res.json() as { tenant_access_token?: string };
  return data.tenant_access_token ?? '';
}

interface JuniorCommentThread {
  docId: string;
  commentId: string;
  featureWorkItemId?: string;
  featureName?: string;
  prdUrl: string;
  askerOpenId: string;
  lastJuniorReplyAtIso: string;
}

interface PostFeatureMapping {
  workItemId: string;
  featureName: string;
  prdUrl: string;
  sentAtIso: string;
}

interface DigestState {
  juniorCommentThreads?: Record<string, JuniorCommentThread>;
  postFeatureMap?: Record<string, PostFeatureMapping>;
  [k: string]: unknown;
}

/**
 * Look up a Lark post message_id (sent by Hamlet via Send-to-PM-Group)
 * in the shared state.postFeatureMap. Returns the originating feature
 * info or null. Used to inject prdUrl into chat() ctx so feature
 * context auto-resolves in PM-group thread replies.
 */
export async function readPostFeatureMapping(msgId: string): Promise<PostFeatureMapping | null> {
  if (!msgId) return null;
  try {
    const token = await getGcsToken();
    const url = `https://storage.googleapis.com/storage/v1/b/${STATE_BUCKET}/o/${encodeURIComponent(STATE_PATH)}?alt=media`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const state = await res.json() as DigestState;
    return state.postFeatureMap?.[msgId] ?? null;
  } catch {
    return null;
  }
}

/**
 * Find a Hamlet-cached feature whose PRD URL contains the given docId.
 * Returns the cached feature (with at least .name and .prd) or null.
 */
export async function findFeatureByDocId(docId: string): Promise<{ name: string; prd: string } | null> {
  if (!docId) return null;
  try {
    const { loadHamletFeatures } = await import('./hamlet-cache');
    const features = await loadHamletFeatures();
    const m = features.find(f => f.prd && f.prd.includes(docId));
    if (!m || !m.prd) return null;
    return { name: m.name, prd: m.prd };
  } catch (e) {
    console.warn('[letjr-followup] findFeatureByDocId failed:', e);
    return null;
  }
}

export async function readJuniorCommentThread(docId: string, commentId: string): Promise<JuniorCommentThread | null> {
  if (!docId || !commentId) return null;
  try {
    const token = await getGcsToken();
    const url = `https://storage.googleapis.com/storage/v1/b/${STATE_BUCKET}/o/${encodeURIComponent(STATE_PATH)}?alt=media`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const state = await res.json() as DigestState;
    return state.juniorCommentThreads?.[`${docId}:${commentId}`] ?? null;
  } catch {
    return null;
  }
}

export interface FetchedReply {
  text: string;
  /** open_ids of every user mentioned in this reply (via the `person` element). */
  mentionedOpenIds: string[];
}

/**
 * Fetch the full comment thread context: the doc snippet the comment
 * is anchored to (`quote`), the original parent comment text, then
 * every reply chronologically. Hand this to Junior as THREAD PARENT
 * CONTEXT so it sees the full conversation, not just the latest reply.
 */
export async function fetchCommentThread(docId: string, commentId: string): Promise<string> {
  if (!docId || !commentId) return '';
  try {
    const token = await getLarkBotToken();
    // GET /comments/:id returns the parent comment + its reply_list.
    const res = await fetch(
      `${LARK_BASE_URL}/open-apis/drive/v1/files/${docId}/comments/${commentId}?file_type=docx&user_id_type=open_id`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json() as {
      code: number;
      data?: {
        comment_id?: string;
        user_id?: string;
        quote?: string;
        is_solved?: boolean;
        reply_list?: { replies?: Array<{
          user_id?: string;
          create_time?: number;
          content?: { elements?: Array<{
            type?: string;
            text_run?: { text?: string };
            person?: { user_id?: string };
          }> };
        }> };
      };
    };
    if (data.code !== 0) return '';
    const c = data.data ?? {};
    const lines: string[] = [];
    if (c.quote) {
      lines.push(`Comment is anchored on this doc snippet: "${c.quote.slice(0, 400)}"`);
      lines.push('');
    }
    const replies = c.reply_list?.replies ?? [];
    if (replies.length === 0) return lines.join('\n').trim();
    // The first reply IS the parent comment text (Lark stores the
    // original comment body as the first reply in the thread).
    lines.push('Comment thread (chronological):');
    replies.forEach((r, i) => {
      let text = '';
      for (const el of r.content?.elements ?? []) {
        if (el.type === 'text_run') text += el.text_run?.text ?? '';
        else if (el.type === 'person' && el.person?.user_id) text += `@${el.person.user_id}`;
      }
      const t = text.trim();
      if (!t) return;
      const tag = i === 0 ? 'original' : 'reply';
      lines.push(`  [${tag} by ${r.user_id ?? '?'}]: ${t}`);
    });
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Post a PRD comment reply directly (no proposal step). Mirrors
 * lib/letjr.ts's sendPrdCommentReply (asker @-tag via `person`,
 * inline at-tags parsed from the reply text). Used by the drive
 * comment auto-reply path in webhook/route.ts.
 */
export async function sendPrdCommentReplyExternal(
  prdUrl: string,
  commentId: string,
  askerOpenId: string,
  replyText: string,
): Promise<boolean> {
  if (!prdUrl || !commentId) return false;
  const token = await getLarkBotToken();
  const docId = await resolveDocId(prdUrl, token);
  if (!docId) return false;
  const elements = buildElements(askerOpenId, replyText);
  const url = `${LARK_BASE_URL}/open-apis/drive/v1/files/${docId}/comments/${commentId}/replies?file_type=docx&user_id_type=open_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { elements } }),
  });
  const data = await res.json() as { code: number; msg?: string };
  if (data.code !== 0) {
    console.warn(`[letjr-followup] PRD comment reply failed: code=${data.code} msg=${data.msg}`);
    return false;
  }
  return true;
}

async function resolveDocId(url: string, token: string): Promise<string> {
  const wikiMatch = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikiMatch) {
    const res = await fetch(`${LARK_BASE_URL}/open-apis/wiki/v2/spaces/get_node?token=${wikiMatch[1]}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as { data?: { node?: { obj_token?: string } } };
    return data.data?.node?.obj_token ?? '';
  }
  const docxMatch = url.match(/\/docx\/([A-Za-z0-9]+)/);
  return docxMatch?.[1] ?? '';
}

function buildElements(askerOpenId: string, replyText: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (askerOpenId) {
    out.push({ type: 'person', person: { user_id: askerOpenId } });
    out.push({ type: 'text_run', text_run: { text: ' ' } });
  }
  const re = /<at\s+user_id=(?:"|')([^"']+)(?:"|')\s*>(?:[^<]*)<\/at>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(replyText)) !== null) {
    if (m.index > last) {
      const chunk = replyText.slice(last, m.index);
      if (chunk) out.push({ type: 'text_run', text_run: { text: chunk } });
    }
    out.push({ type: 'person', person: { user_id: m[1] } });
    last = re.lastIndex;
  }
  if (last < replyText.length) {
    out.push({ type: 'text_run', text_run: { text: replyText.slice(last) } });
  }
  if (out.length === 0) {
    out.push({ type: 'text_run', text_run: { text: replyText } });
  }
  return out;
}

/**
 * Fetch a single reply within a comment thread from Lark drive
 * comments API and return its decoded text + mentioned open_ids.
 * Returns null on any error.
 */
export async function fetchCommentReply(
  docId: string,
  commentId: string,
  replyId: string,
): Promise<FetchedReply | null> {
  if (!docId || !commentId) return null;
  try {
    const token = await getLarkBotToken();
    const res = await fetch(
      `${LARK_BASE_URL}/open-apis/drive/v1/files/${docId}/comments/${commentId}/replies?file_type=docx&user_id_type=open_id`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json() as {
      code: number;
      data?: { items?: Array<{
        reply_id?: string;
        content?: { elements?: Array<{
          type?: string;
          text_run?: { text?: string };
          person?: { user_id?: string };
          mention_user?: { user_id?: string };
        }> };
      }> };
    };
    if (data.code !== 0) return null;
    const items = data.data?.items ?? [];
    // Lark returns ALL replies in the thread; pick the one matching reply_id,
    // or fall back to the last reply if reply_id doesnt match (defensive).
    let target = items.find(r => r.reply_id === replyId);
    if (!target) target = items[items.length - 1];
    if (!target) return null;
    const elements = target.content?.elements ?? [];
    let text = '';
    const mentionedOpenIds: string[] = [];
    for (const el of elements) {
      if (el.type === 'text_run') {
        text += el.text_run?.text ?? '';
      } else if (el.type === 'person' && el.person?.user_id) {
        mentionedOpenIds.push(el.person.user_id);
      } else if (el.type === 'mention_user' && el.mention_user?.user_id) {
        mentionedOpenIds.push(el.mention_user.user_id);
      }
    }
    return { text: text.trim(), mentionedOpenIds };
  } catch {
    return null;
  }
}
