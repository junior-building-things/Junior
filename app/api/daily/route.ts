import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { sendCardMessage } from '@/lib/lark';

export const maxDuration = 60;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite';

const DAILY_SYSTEM_PROMPT = `You are a disciplined AI research assistant.
Return 5 up and coming AI stocks that are public on any major exchanges globally. Focus on stocks with a market cap under 1B USD.
Output must follow this exact markdown structure for each stock:

**{emoji} {Company Name} ({TICKER})**
- **Stock Exchange:** {value}
- **Market Cap:** {value}
- **Last Price:** {value}
- **Business Description:** {value}
- **Value Proposition:** {value}
- **Recent News:** {value}

Rules:
- Provide exactly 5 stocks.
- Use one relevant emoji before each company name.
- Keep only category labels bolded; values must not be bold.
- Provide currency symbols. Do not convert currencies.
- For Recent News, include a brief statement and source URL.
- Do not output tables.`;

async function buildMarketSnapshot(): Promise<string> {
  const apiKey = process.env.FINANCE_API_KEY;
  if (!apiKey) return '';

  const tickers = (process.env.DAILY_TICKERS ?? '').split(',').map(t => t.trim()).filter(Boolean);
  if (tickers.length === 0) return '';

  const rows: string[] = [];
  for (const ticker of tickers) {
    try {
      const [qRes, pRes] = await Promise.all([
        fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`),
        fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${apiKey}`),
      ]);
      const q = await qRes.json() as { c?: number; pc?: number };
      const p = await pRes.json() as { name?: string; marketCapitalization?: number };
      if (typeof q.c !== 'number' || q.c <= 0) continue;

      const parts = [`${p.name || ticker} (${ticker})`, `$${q.c.toFixed(2)}`];
      if (typeof q.pc === 'number' && q.pc > 0) {
        parts.push(`${(((q.c - q.pc) / q.pc) * 100).toFixed(2)}%`);
      }
      rows.push(` - ${parts.join(', ')}`);
    } catch { /* skip */ }
  }
  return rows.length > 0 ? `Finnhub snapshot:\n${rows.join('\n')}` : '';
}

export async function GET(req: NextRequest) {
  // Vercel Cron uses GET
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const chatId = process.env.PROACTIVE_CHAT_ID;
  if (!chatId) return new NextResponse('No PROACTIVE_CHAT_ID', { status: 500 });

  const snapshot = await buildMarketSnapshot();
  const prompt = `Generate today's update.\nUse the snapshot below as input and web search for context.\n${snapshot}`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: DAILY_SYSTEM_PROMPT,
        tools: [{ googleSearch: {} }],
      },
    });
    const body = response.text ?? 'No updates today.';
    const today = new Date().toISOString().split('T')[0];
    await sendCardMessage(chatId, `AI Stock Picks (${today})`, body);
  } catch (err) {
    console.error('Daily generation error:', err);
    return new NextResponse('Failed', { status: 502 });
  }

  return new NextResponse('Sent', { status: 200 });
}
