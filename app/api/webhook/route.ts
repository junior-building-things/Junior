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
  const [{ shouldReply, sanitizeText, sendReply, sendMessage, reactToMessage }, { loadMessages, saveMessages, recordEventOnce }, { chat }] = await Promise.all([
    import('@/lib/lark'),
    import('@/lib/store'),
    import('@/lib/gemini'),
  ]);

  const header = (data.header ?? {}) as Record<string, unknown>;
  const eventType = header.event_type;
  if (eventType && eventType !== 'im.message.receive_v1') {
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

  // React with a thinking emoji while processing
  if (messageId) {
    reactToMessage(messageId, 'OnIt').catch(() => {});
  }

  // Handle reset command
  if (userText.trim().toLowerCase() === 'reset') {
    await saveMessages(chatId, []);
    try {
      if (messageId) await sendReply(messageId, 'Chat history cleared.', senderOpenId, senderName);
      else await sendMessage(chatId, 'Chat history cleared.');
    } catch {}
    return new Response('', { status: 200 });
  }

  // Load chat history and generate response
  const history = await loadMessages(chatId);

  let reply: string;
  try {
    reply = await chat(history, userText, { senderOpenId, senderName, chatId });
  } catch (err) {
    console.error('Gemini error:', err);
    reply = "Sorry, I hit an error processing that. Try again?";
  }

  // Save messages (skip failed responses to avoid polluting history)
  if (reply && reply !== 'No response generated.') {
    history.push({ role: 'user', content: userText });
    history.push({ role: 'model', content: reply });
    await saveMessages(chatId, history);
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

  return new Response('', { status: 200 });
}
