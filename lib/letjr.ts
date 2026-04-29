/**
 * "Let Jr. Reply" reaction-driven send.
 *
 * Hamlet's Outstanding Questions card includes a "Let Jr. Reply"
 * button. When clicked, Hamlet drafts a reply via Gemini and posts
 * it as a thread reply to the digest card with footer
 * "Looks ok? React with 👍 and I'll send it." Hamlet records the
 * proposal in `gs://tiktok-im-hamlet-state/digests/chat-risks.json`
 * under `pendingLetJrReplies[<proposal_msg_id>]`.
 *
 * This module is the consumer side: when Junior's webhook sees a 👍
 * reaction on a tracked proposal message, it pulls the pending entry,
 * sends the reply to the destination (PRD comment thread or feature
 * group chat) tagging the original asker, and removes the entry.
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

export interface PendingLetJrReply {
  replyText: string;
  askerOpenId: string;
  destination: 'prd_comment' | 'chat';
  prdUrl?: string;
  commentId?: string;
  chatId?: string;
  chatParentMessageId?: string;
  proposedAtIso: string;
}

interface DigestState {
  pendingLetJrReplies?: Record<string, PendingLetJrReply>;
  [k: string]: unknown;
}

async function readDigestState(): Promise<DigestState | null> {
  const token = await getGcsToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${STATE_BUCKET}/o/${encodeURIComponent(STATE_PATH)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return await res.json() as DigestState;
}

async function writeDigestState(state: DigestState): Promise<void> {
  const token = await getGcsToken();
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${STATE_BUCKET}/o?uploadType=media&name=${encodeURIComponent(STATE_PATH)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`writeDigestState failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

/**
 * Look up + remove a pending Jr. reply by the proposal message_id.
 * Returns the entry or null if there's nothing tracked for that id.
 * The remove + write happens before the actual send, so a partial
 * failure doesn't leave the entry hanging — re-adding manually is
 * cheap if needed.
 */
export async function consumePendingReply(messageId: string): Promise<PendingLetJrReply | null> {
  const state = await readDigestState();
  if (!state?.pendingLetJrReplies?.[messageId]) return null;
  const entry = state.pendingLetJrReplies[messageId];
  delete state.pendingLetJrReplies[messageId];
  await writeDigestState(state);
  return entry;
}

// ─── Lark API senders ──────────────────────────────────────────────────────

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

/**
 * Reply to a Lark drive doc comment thread.
 *
 * Tries to render an @mention of the asker first (so the reply
 * actually pings them), and falls back to plain text if Lark rejects
 * the mention element. The earlier 99992402 failure was probably from
 * the missing `user_id_type=open_id` query param — Lark needs to know
 * what flavor of id we're passing.
 */
async function sendPrdCommentReply(
  prdUrl: string,
  commentId: string,
  askerOpenId: string,
  replyText: string,
): Promise<boolean> {
  const token = await getLarkBotToken();
  const docId = await resolveDocId(prdUrl, token);
  if (!docId) return false;

  const post = async (elements: Array<Record<string, unknown>>, withUserIdType: boolean) => {
    const url = `${LARK_BASE_URL}/open-apis/drive/v1/files/${docId}/comments/${commentId}/replies?file_type=docx${withUserIdType ? '&user_id_type=open_id' : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { elements } }),
    });
    return await res.json() as { code: number; msg?: string };
  };

  // Build the element list. The reply may contain inline
  // <at user_id="ou_xxx"></at> tags (e.g. when Gemini punts to the PM
  // with a real Lark mention). Drive-comment replies need those split
  // into `person` elements interleaved with `text_run` elements.
  const elements = buildCommentElements(askerOpenId, replyText);
  // First attempt with user_id_type=open_id (mentions need it).
  let data = await post(elements, true);
  if (data.code === 0) {
    console.log(`[letjr] PRD comment reply OK (${elements.length} elements)`);
    return true;
  }
  console.warn(`[letjr] PRD comment reply with mentions failed: code=${data.code} msg=${data.msg} — falling back to plain text`);

  const plain = [{ type: 'text_run', text_run: { text: stripAtTags(replyText) } }];
  data = await post(plain, false);
  if (data.code !== 0) {
    console.warn(`[letjr] PRD comment reply failed: code=${data.code} msg=${data.msg}`);
    return false;
  }
  return true;
}

/**
 * Build a Lark drive-comment elements list: a leading person mention
 * for the asker (if known), then the reply body with any inline
 * <at user_id="ou_xxx"></at> tags promoted to person elements.
 */
function buildCommentElements(askerOpenId: string, replyText: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (askerOpenId) {
    out.push({ type: 'person', person: { user_id: askerOpenId } });
    out.push({ type: 'text_run', text_run: { text: ' ' } });
  }
  // Split replyText on <at ...></at> tags (with optional inner text).
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

/** Remove all <at user_id=...></at> tags so plain-text fallback doesnt
 *  expose raw markup to readers. */
function stripAtTags(s: string): string {
  return s.replace(/<at\s+user_id=(?:"|')([^"']+)(?:"|')\s*>(?:[^<]*)<\/at>/g, '@user');
}

/**
 * Send a reply into a feature group chat. If `parentMessageId` is set,
 * the reply lands in that thread; otherwise it's a top-level message.
 * Uses a Lark `text` message with an `<at>` tag for the asker so the
 * mention renders properly.
 */
async function sendChatReply(
  chatId: string,
  parentMessageId: string | undefined,
  askerOpenId: string,
  replyText: string,
): Promise<boolean> {
  const token = await getLarkBotToken();
  const mention = askerOpenId ? `<at user_id="${askerOpenId}"></at> ` : '';
  const text = `${mention}${replyText}`;
  if (parentMessageId) {
    const res = await fetch(`${LARK_BASE_URL}/open-apis/im/v1/messages/${parentMessageId}/reply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: true }),
    });
    const data = await res.json() as { code: number; msg?: string };
    if (data.code !== 0) {
      console.warn(`[letjr] chat reply (thread) failed: code=${data.code} msg=${data.msg}`);
      return false;
    }
    return true;
  }
  const res = await fetch(`${LARK_BASE_URL}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  const data = await res.json() as { code: number; msg?: string };
  if (data.code !== 0) {
    console.warn(`[letjr] chat reply (top-level) failed: code=${data.code} msg=${data.msg}`);
    return false;
  }
  return true;
}

/**
 * Dispatch a consumed proposal to its destination. On a successful
 * chat-destination send, also append the reply to the chat-level
 * history file so future Junior turns in the same chat see what
 * was already answered.
 */
export async function sendPending(entry: PendingLetJrReply): Promise<boolean> {
  if (entry.destination === 'prd_comment') {
    if (!entry.prdUrl || !entry.commentId) return false;
    return sendPrdCommentReply(entry.prdUrl, entry.commentId, entry.askerOpenId, entry.replyText);
  }
  if (entry.destination === 'chat') {
    if (!entry.chatId) return false;
    const ok = await sendChatReply(entry.chatId, entry.chatParentMessageId, entry.askerOpenId, entry.replyText);
    if (ok) {
      try {
        const { appendTurn } = await import('./store');
        // Pair the reply with a synthetic user note so Gemini sees the
        // alternation and knows this turn is a letjr-flow answer to a
        // chat question (the actual question lives in the parent thread,
        // surfaced via THREAD PARENT CONTEXT when relevant).
        await appendTurn(
          entry.chatId,
          entry.askerOpenId ?? '',
          '(question from chat — see thread above)',
          entry.replyText,
        );
      } catch (e) {
        console.warn('[letjr] failed to append chat-history turn for letjr reply:', e);
      }
    }
    return ok;
  }
  return false;
}
