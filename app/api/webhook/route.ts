export async function POST(req: Request) {
  const data = await req.json();

  // Lark URL verification challenge — respond immediately, no imports
  if (data.challenge) {
    return Response.json({ challenge: data.challenge });
  }

  // Lazy-load heavy modules only for actual messages
  const [{ shouldReply, sanitizeText, sendReply, sendMessage, reactToMessage }, { loadMessages, saveMessages, recordEventOnce }, { chat }] = await Promise.all([
    import('@/lib/lark'),
    import('@/lib/store'),
    import('@/lib/gemini'),
  ]);

  const header = data.header ?? {};
  const eventType = header.event_type;
  if (eventType && eventType !== 'im.message.receive_v1') {
    return new Response('', { status: 200 });
  }

  const event = data.event ?? {};

  // Prevent bot loop
  if (event.sender?.sender_type !== 'user') {
    return new Response('', { status: 200 });
  }

  const message = event.message ?? {};
  const chatId = message.chat_id;
  const messageId = message.message_id;
  const sender = event.sender ?? {};
  const senderOpenId = sender.sender_id?.open_id;
  const senderName = sender.sender_name ?? sender.name;

  let userText: string;
  try {
    const contentObj = JSON.parse(message.content ?? '{}');
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
  if (dedupeKey && !(await recordEventOnce(dedupeKey))) {
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
    reply = await chat(history, userText, { senderOpenId, senderName });
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
