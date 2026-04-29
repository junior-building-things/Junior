import { createHash, createDecipheriv } from 'crypto';

const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN ?? '';
const LARK_ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY ?? '';

function decryptPayload(encrypted: string): Record<string, unknown> {
  if (!LARK_ENCRYPT_KEY) throw new Error('Cannot decrypt without LARK_ENCRYPT_KEY');
  const key = createHash('sha256').update(LARK_ENCRYPT_KEY).digest();
  const buf = Buffer.from(encrypted, 'base64');
  const iv = buf.subarray(0, 16);
  const ciphertext = buf.subarray(16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  return JSON.parse(decrypted);
}

function verifySignature(req: Request, body: string): boolean {
  // If no signing secret is configured, skip verification (dev mode)
  if (!LARK_ENCRYPT_KEY) return true;

  const timestamp = req.headers.get('X-Lark-Request-Timestamp') ?? '';
  const nonce = req.headers.get('X-Lark-Request-Nonce') ?? '';
  const signature = req.headers.get('X-Lark-Signature') ?? '';
  if (!timestamp || !nonce || !signature) return false;

  // Lark uses plain SHA-256: sha256(timestamp + nonce + encrypt_key + body)
  const expected = createHash('sha256')
    .update(timestamp + nonce + LARK_ENCRYPT_KEY + body)
    .digest('hex');
  return expected === signature;
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  let data = JSON.parse(rawBody) as Record<string, unknown>;

  // Decrypt if payload is encrypted
  if (typeof data.encrypt === 'string' && LARK_ENCRYPT_KEY) {
    try {
      data = decryptPayload(data.encrypt as string);
    } catch (err) {
      console.error('[webhook] Decryption failed:', err);
      return new Response('Decryption failed', { status: 400 });
    }
  }

  // Lark URL verification challenge — respond immediately, no imports
  if (data.challenge) {
    // Optionally verify token if configured
    if (LARK_VERIFICATION_TOKEN && data.token !== LARK_VERIFICATION_TOKEN) {
      return new Response('Invalid verification token', { status: 403 });
    }
    return Response.json({ challenge: data.challenge });
  }

  // Verify request signature for all non-challenge requests
  if (!verifySignature(req, rawBody)) {
    return new Response('Invalid signature', { status: 403 });
  }

  // Lazy-load heavy modules only for actual messages
  const [{ shouldReply, sanitizeText, sendReply, sendMessage, reactToMessage, removeReaction }, { loadMergedHistory, appendTurn, clearChatHistory, clearUserHistory, recordEventOnce }, { chat }] = await Promise.all([
    import('@/lib/lark'),
    import('@/lib/store'),
    import('@/lib/gemini'),
  ]);

  const header = (data.header ?? {}) as Record<string, unknown>;
  const eventType = header.event_type;

  // Handle 👍 reactions on Hamlet's "Let Jr. Reply" proposal messages.
  // When the owner thumbs-ups a draft, look up the pending entry in
  // GCS, send the prepared reply to its destination (PRD comment or
  // feature group chat), and clear the entry.
  if (eventType === 'im.message.reaction.created_v1') {
    const reactionEvent = (data.event ?? {}) as {
      message_id?: string;
      reaction_type?: { emoji_type?: string };
      operator_type?: string;
      user_id?: { open_id?: string };
    };
    const messageId = reactionEvent.message_id;
    const emoji = reactionEvent.reaction_type?.emoji_type ?? '';
    const reactor = reactionEvent.user_id?.open_id;
    // Lark uses 'THUMBSUP' for 👍; some clients emit 'LIKE'. Accept both.
    const isThumbsUp = emoji === 'THUMBSUP' || emoji === 'LIKE';
    if (messageId && isThumbsUp) {
      // Optional owner gate: if OWNER_OPEN_ID is set, only the owner
      // can trigger an auto-send.
      const ownerOpenId = process.env.OWNER_OPEN_ID;
      if (ownerOpenId && reactor !== ownerOpenId) {
        console.log(`[letjr] ignoring 👍 from ${reactor} (not owner)`);
        return new Response('', { status: 200 });
      }
      try {
        const { consumePendingReply, sendPending } = await import('@/lib/letjr');
        const entry = await consumePendingReply(messageId);
        if (entry) {
          const ok = await sendPending(entry);
          console.log(`[letjr] reaction-triggered send for msg=${messageId} → ${ok ? 'OK' : 'FAILED'}`);
        }
      } catch (e) {
        console.warn('[letjr] reaction handler error:', e);
      }
    }
    return new Response('', { status: 200 });
  }

  // PHASE 1: log unknown event types so we can see whats coming in
  // when we (manually) enable additional Lark event subscriptions —
  // specifically the drive doc comment events that would let Junior
  // reply in real time when someone follows up on a comment thread he
  // has already posted into. Tracker state is already populated in
  // state.juniorCommentThreads (see lib/letjr.ts). Once we confirm the
  // event name + payload shape from these logs, well wire a real
  // handler here that diffs the thread against lastJuniorReplyAtIso
  // and triggers the letjr_reply draft+propose flow for any new
  // non-Junior reply.
  if (eventType && eventType !== 'im.message.receive_v1') {
    const t = String(eventType);
    if (t.startsWith('drive.') || t.includes('comment')) {
      try {
        const preview = JSON.stringify(data).slice(0, 1500);
        console.log(`[webhook] unhandled drive/comment event type=${t} payload=${preview}`);
      } catch { /* ignore */ }
    } else {
      console.log(`[webhook] unhandled event type=${t}`);
    }
    return new Response('', { status: 200 });
  }

  const event = (data.event ?? {}) as Record<string, unknown>;

  // Prevent bot loop
  const sender = (event.sender ?? {}) as Record<string, unknown>;
  if (sender.sender_type !== 'user') {
    return new Response('', { status: 200 });
  }

  const message = (event.message ?? {}) as Record<string, unknown>;
  const chatId = message.chat_id as string | undefined;
  const messageId = message.message_id as string | undefined;
  const parentId = message.parent_id as string | undefined;
  const rootId = message.root_id as string | undefined;
  const senderOpenId = (sender.sender_id as Record<string, unknown> | undefined)?.open_id as string | undefined;
  const senderName = (sender.sender_name ?? sender.name) as string | undefined;

  let userText: string;
  try {
    const contentObj = JSON.parse((message.content as string) ?? '{}');
    userText = sanitizeText(contentObj.text ?? '');
  } catch {
    return new Response('', { status: 200 });
  }

  if (!userText || !chatId) {
    return new Response('', { status: 200 });
  }

  if (!shouldReply(event)) {
    return new Response('', { status: 200 });
  }

  // Deduplication
  const dedupeKey = messageId
    ? `msg:${messageId}`
    : header.event_id
      ? `evt:${header.event_id}`
      : null;
  if (dedupeKey && !(await recordEventOnce(dedupeKey as string))) {
    return new Response('', { status: 200 });
  }

  // Handle reset command — clears BOTH the chat-level history and the
  // sender's cross-chat user history. Accepts "reset" or "/reset"
  // (any leading slashes stripped). Reset is instant, so we skip the
  // Typing reaction for it.
  const resetCmd = userText.trim().toLowerCase().replace(/^\/+/, '');
  if (resetCmd === 'reset') {
    await Promise.all([
      clearChatHistory(chatId),
      senderOpenId ? clearUserHistory(senderOpenId) : Promise.resolve(),
    ]);
    const msg = senderOpenId
      ? 'Chat history and your personal cross-chat memory cleared.'
      : 'Chat history cleared.';
    try {
      if (messageId) await sendReply(messageId, msg, senderOpenId, senderName);
      else await sendMessage(chatId, msg);
    } catch {}
    return new Response('', { status: 200 });
  }

  // React with a "Typing" emoji while we process. We hold onto the
  // returned reaction_id (as a promise) so we can remove the indicator
  // after the reply has been sent. Done in parallel — the reply path
  // doesnt wait on the reaction call.
  const reactionIdPromise: Promise<string | null> = messageId
    ? reactToMessage(messageId, 'Typing')
    : Promise.resolve(null);

  // Card-edit routing: if this is a reply in a thread on a tracked
  // AB card (either a direct reply to the bot's "what would you like
  // to change?" prompt OR a generic reply in the same thread), treat
  // the user text as the edit instruction.
  console.log(`[webhook] msg=${messageId} parent=${parentId ?? '(none)'} root=${rootId ?? '(none)'}`);
  if (parentId || rootId) {
    try {
      const { readPendingCardEdit, readPendingCardEditByCardMsgId, readCardEditContext, editSectionWithGemini, applyEditViaHamlet } = await import('@/lib/card-edit');
      // Prefer parent_id match (direct reply to prompt). Fall back to
      // root_id (the thread is anchored on the AB card itself, so the
      // user might reply to the card rather than to the prompt).
      let pending = parentId ? await readPendingCardEdit(parentId) : null;
      if (!pending && rootId) pending = await readPendingCardEditByCardMsgId(rootId);
      if (!pending && parentId) pending = await readPendingCardEditByCardMsgId(parentId);
      console.log(`[webhook] pending edit lookup: ${pending ? `match (${pending.featureName})` : 'no match'}`);
      if (pending) {
        const ctx = await readCardEditContext(pending.cardMsgId);
        const featureSnap = ctx?.features.find(f => f.workItemId === pending.featureWorkItemId);
        const sendResult = async (text: string) => {
          try {
            if (messageId) await sendReply(messageId, text, senderOpenId, senderName);
            else await sendMessage(chatId, text);
          } catch {}
        };
        const cleanupReaction = () => {
          if (messageId) {
            reactionIdPromise
              .then(rid => { if (rid) return removeReaction(messageId, rid); })
              .catch(() => {});
          }
        };
        if (!featureSnap) {
          await sendResult(`Couldn't find the saved card snapshot for **${pending.featureName}**. The card may be too old (snapshots are kept for 30 days).`);
          cleanupReaction();
          return new Response('', { status: 200 });
        }
        const newMd = await editSectionWithGemini(pending.featureName, featureSnap.cardContent, userText);
        if (!newMd) {
          await sendResult("Sorry, I couldn't apply that edit (Gemini failure). Try rewording?");
          cleanupReaction();
          return new Response('', { status: 200 });
        }
        if (newMd.trim() === featureSnap.cardContent.trim()) {
          await sendResult("Looks like nothing changed — was the instruction unclear? Try being more specific (e.g. \"update the first bullet of A/B Results to ...\").");
          cleanupReaction();
          return new Response('', { status: 200 });
        }
        const ok = await applyEditViaHamlet(pending.cardMsgId, pending.featureWorkItemId, newMd);
        await sendResult(ok ? 'Updated ✅' : "Edit applied locally but Hamlet couldn't patch the card — check the Hamlet logs.");
        cleanupReaction();
        return new Response('', { status: 200 });
      }
    } catch (e) {
      console.warn('[webhook] card-edit detection failed:', e);
      // fall through to normal chat handling
    }
  }

  // Load merged history (chat-level + this user's cross-chat history).
  const history = await loadMergedHistory(chatId, senderOpenId);

  // If this message is a thread reply, fetch the parent message body
  // so we can give Junior context for "this" / "that" references.
  // Best-effort: a fetch failure just means no context — better than
  // failing the whole turn.
  let parentMessageContent = '';
  if (parentId) {
    try {
      const { fetchMessageText } = await import('@/lib/lark');
      parentMessageContent = await fetchMessageText(parentId);
      if (parentMessageContent) {
        console.log(`[webhook] thread parent fetched (${parentMessageContent.length} chars)`);
      }
    } catch (e) {
      console.warn('[webhook] fetch parent message failed:', e);
    }
  }

  let reply: string;
  try {
    reply = await chat(history, userText, { senderOpenId, senderName, chatId, parentMessageContent });
  } catch (err) {
    console.error('Gemini error:', err);
    reply = "Sorry, I hit an error processing that. Try again?";
  }

  // Persist the new turn to BOTH the chat-level and user-level files.
  // Skip on known-bad replies to keep history clean.
  if (reply && reply !== 'Sorry, can you try asking that again?') {
    await appendTurn(chatId, senderOpenId ?? '', userText, reply);
  }

  // Send reply
  try {
    if (messageId) {
      await sendReply(messageId, reply, senderOpenId, senderName);
    } else {
      await sendMessage(chatId, reply);
    }
  } catch (err) {
    console.error('Lark send error:', err);
  }

  // Clean up the "Typing" reaction now that the reply (or error) has
  // been delivered. Fire-and-forget — failures here arent worth
  // surfacing to the user.
  if (messageId) {
    reactionIdPromise
      .then(reactionId => { if (reactionId) return removeReaction(messageId, reactionId); })
      .catch(() => {});
  }

  return new Response('', { status: 200 });
}
