/**
 * Junior-side handling of the AB card "Edit" flow.
 *
 * Hamlet's card-action endpoint records a pendingCardEdits entry keyed
 * by the prompt message_id (the bot's "what would you like to change?"
 * reply). When a user replies to that prompt, this module:
 *  1. Looks up the pending edit + the card's full context.
 *  2. Asks Gemini to apply the user's edit instruction to the section's
 *     markdown content.
 *  3. Calls Hamlet's /api/cards/edit-section to rebuild + patch the card.
 *  4. Posts a confirmation reply in the same thread.
 *
 * State lives in `gs://tiktok-im-hamlet-state/digests/chat-risks.json`
 * (the same file letjr.ts uses).
 */

const STATE_BUCKET = 'tiktok-im-hamlet-state';
const STATE_PATH = 'digests/chat-risks.json';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

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

export interface PendingCardEdit {
  cardMsgId: string;
  cardKind: 'ab_open' | 'ab_concluded';
  featureWorkItemId: string;
  featureName: string;
  chatId: string;
  requestedByOpenId: string;
  requestedAtIso: string;
}

export interface CardEditContextFeature {
  workItemId: string;
  featureName: string;
  cardContent: string;
  cardImages: Array<{ image_key: string; alt?: string }>;
  postTitle: string;
  postParagraphsJson: string;
  libraUrl: string;
  abReportUrl?: string;
}

export interface CardEditContext {
  cardKind: 'ab_open' | 'ab_concluded';
  chatId: string;
  headerText: string;
  headerTemplate: string;
  features: CardEditContextFeature[];
  createdAt: string;
}

interface DigestState {
  pendingCardEdits?: Record<string, PendingCardEdit>;
  cardEditContexts?: Record<string, CardEditContext>;
  [k: string]: unknown;
}

async function readDigestState(): Promise<DigestState | null> {
  const token = await getGcsToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${STATE_BUCKET}/o/${encodeURIComponent(STATE_PATH)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return await res.json() as DigestState;
}

export async function readPendingCardEdit(promptMsgId: string): Promise<PendingCardEdit | null> {
  if (!promptMsgId) return null;
  const state = await readDigestState();
  return state?.pendingCardEdits?.[promptMsgId] ?? null;
}

export async function readCardEditContext(cardMsgId: string): Promise<CardEditContext | null> {
  if (!cardMsgId) return null;
  const state = await readDigestState();
  return state?.cardEditContexts?.[cardMsgId] ?? null;
}

/**
 * Send the new section content to Hamlet, which rebuilds the card and
 * patches Lark. Returns true on success.
 */
export async function applyEditViaHamlet(
  cardMsgId: string,
  featureWorkItemId: string,
  newCardContent: string,
): Promise<boolean> {
  const HAMLET_URL = process.env.HAMLET_BASE_URL ?? 'https://hamlet-416594255546.asia-southeast1.run.app';
  try {
    const res = await fetch(`${HAMLET_URL}/api/cards/edit-section`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardMsgId, featureWorkItemId, newCardContent }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[card-edit] Hamlet edit-section failed: ${res.status} ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[card-edit] Hamlet edit-section threw:', e);
    return false;
  }
}

/**
 * Use Gemini to apply a natural-language edit instruction to the
 * markdown content of one card section. Returns the new markdown, or
 * null on any failure / no API key.
 */
export async function editSectionWithGemini(
  featureName: string,
  currentMarkdown: string,
  userInstruction: string,
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return null;
  const prompt = `You are editing the markdown body of a Lark card section about a feature called "${featureName}".

Current markdown:
\`\`\`
${currentMarkdown}
\`\`\`

The user wants to apply this edit:
"${userInstruction.replace(/"/g, '\\"')}"

Rules:
- Apply the edit as faithfully as possible. Preserve all unrelated content exactly.
- Keep the existing markdown structure: bold headings (**Heading**:), bullet lines starting with "- ", inline links [text](url), and any <at email=...></at> mentions.
- If the user references "the first bullet of A/B Results", find the "**A/B Results**:" heading and modify the first "- " line under it.
- Do NOT add commentary, code fences, or surrounding quotes. Output ONLY the new markdown body.
- If the instruction is ambiguous or impossible, output the current markdown unchanged.`;

  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    let raw = (response.text ?? '').trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:markdown|md)?\n/, '').replace(/```$/, '').trim();
    }
    return raw || null;
  } catch (e) {
    console.warn('[card-edit] Gemini edit failed:', e);
    return null;
  }
}
