import { NextRequest, NextResponse } from 'next/server';
import { shouldReply, sanitizeText, sendReply, sendMessage, reactToMessage } from '@/lib/lark';
import { loadMessages, saveMessages, recordEventOnce } from '@/lib/store';
import { chat } from '@/lib/gemini';

export const maxDuration = 60; // Vercel Pro: up to 60s

export async function POST(req: NextRequest) {
  const data = await req.json();

  // Lark URL verification challenge
  if (data.challenge) {
    return NextResponse.json({ challenge: data.challenge });
  }

  const header = data.header ?? {};
  const eventType = header.event_type;
  if (eventType && eventType !== 'im.message.receive_v1') {
    return new NextResponse('', { status: 200 });
  }

  const event = data.event ?? {};

  // Prevent bot loop
  if (event.sender?.sender_type !== 'user') {
    return new NextResponse('', { status: 200 });
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
    return new NextResponse('', { status: 200 });
  }

  if (!userText || !chatId) {
    return new NextResponse('', { status: 200 });
  }

  if (!shouldReply(event)) {
    return new NextResponse('', { status: 200 });
  }

  // Deduplication
  const dedupeKey = messageId
    ? `msg:${messageId}`
    : header.event_id
      ? `evt:${header.event_id}`
      : null;
  if (dedupeKey && !(await recordEventOnce(dedupeKey))) {
    return new NextResponse('', { status: 200 });
  }

  // React with a thinking emoji while processing
  if (messageId) {
    reactToMessage(messageId, 'OnIt').catch(() => {});
  }

  // Load chat history and generate response
  const history = await loadMessages(chatId);

  let reply: string;
  try {
    reply = await chat(history, userText);
  } catch (err) {
    console.error('Gemini error:', err);
    reply = "Sorry, I hit an error processing that. Try again?";
  }

  // Save messages
  history.push({ role: 'user', content: userText });
  history.push({ role: 'model', content: reply });
  await saveMessages(chatId, history);

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

  return new NextResponse('', { status: 200 });
}
