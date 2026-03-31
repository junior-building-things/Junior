import { GoogleGenAI, Type, FunctionCallingConfigMode, FunctionDeclaration } from '@google/genai';
import { ChatMessage } from './types';
import * as meego from './meego';
import * as lark from './lark';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite';

// ─── Tool definitions ────────────────────────────────────────────────────────

const tools: FunctionDeclaration[] = [
  {
    name: 'get_my_features',
    description: 'List all active features/stories assigned to the user in Meego with their current status, priority, and links.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'get_feature_status',
    description: 'Get detailed status of a specific feature by its Meego URL, including team members, priority, PRD link, and current workflow node.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        meego_url: { type: Type.STRING, description: 'The Meego URL of the feature (e.g. https://meego.larkoffice.com/TikTok/story/detail/12345)' },
      },
      required: ['meego_url'],
    },
  },
  {
    name: 'search_feature',
    description: 'Search for features by name keyword in the user\'s Meego projects.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Search keyword to match against feature names' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_feature',
    description: 'Create a new feature/story in Meego and optionally generate a PRD document.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'Name of the feature to create' },
        priority: { type: Type.STRING, description: 'Priority level: P0, P1, P2, or P3. Defaults to P2.' },
        create_prd: { type: Type.BOOLEAN, description: 'Whether to also create a PRD document from template. Defaults to true.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'complete_workflow_node',
    description: 'Mark a workflow node as complete for a feature in Meego.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        project_key: { type: Type.STRING, description: 'Meego project key (e.g. "TikTok")' },
        work_item_id: { type: Type.STRING, description: 'The work item ID number' },
        node_key: { type: Type.STRING, description: 'The node state key to complete' },
      },
      required: ['project_key', 'work_item_id', 'node_key'],
    },
  },
  {
    name: 'read_document',
    description: 'Read the content of a Lark document given its URL. Returns plain text with headings.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        doc_url: { type: Type.STRING, description: 'Lark document URL (docx or wiki link)' },
      },
      required: ['doc_url'],
    },
  },
  {
    name: 'edit_document_section',
    description: 'Edit a specific section in a Lark document by replacing the content under a heading.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        doc_url: { type: Type.STRING, description: 'Lark document URL' },
        section_heading: { type: Type.STRING, description: 'The heading text of the section to edit' },
        new_content: { type: Type.STRING, description: 'The new content to replace the section body with' },
      },
      required: ['doc_url', 'section_heading', 'new_content'],
    },
  },
  {
    name: 'add_document_section',
    description: 'Add a new section (heading + content) to a Lark document.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        doc_url: { type: Type.STRING, description: 'Lark document URL' },
        section_title: { type: Type.STRING, description: 'Title for the new section heading' },
        section_content: { type: Type.STRING, description: 'Content for the new section body' },
        after_section: { type: Type.STRING, description: 'Optional: insert after this section heading' },
      },
      required: ['doc_url', 'section_title', 'section_content'],
    },
  },
  {
    name: 'get_stock_price',
    description: 'Get the current stock price and market cap for a given ticker symbol.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticker: { type: Type.STRING, description: 'Stock ticker symbol (e.g. AAPL, TSLA, NVDA)' },
      },
      required: ['ticker'],
    },
  },
];

// ─── Tool execution ──────────────────────────────────────────────────────────

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'get_my_features':
        return await meego.getMyFeatures();

      case 'get_feature_status':
        return await meego.getFeatureStatus(args.meego_url as string);

      case 'search_feature':
        return await meego.searchFeature(args.query as string);

      case 'create_feature': {
        const priority = (args.priority as string) || 'P2';
        const result = await meego.createFeature(args.name as string, priority as 'P0' | 'P1' | 'P2' | 'P3');
        let prdUrl = '';
        if (args.create_prd !== false) {
          try {
            prdUrl = await lark.copyPrdTemplate(args.name as string);
          } catch (e) {
            console.error('PRD creation failed:', e);
          }
        }
        return `Feature created!\nMeego: ${result.meegoUrl}${prdUrl ? `\nPRD: ${prdUrl}` : ''}`;
      }

      case 'complete_workflow_node':
        return await meego.completeNode(
          args.project_key as string,
          args.work_item_id as string,
          args.node_key as string,
        );

      case 'read_document':
        return await lark.readDocContent(args.doc_url as string);

      case 'edit_document_section':
        await lark.editDocSection(args.doc_url as string, args.section_heading as string, args.new_content as string);
        return 'Section updated successfully.';

      case 'add_document_section':
        await lark.addDocSection(
          args.doc_url as string,
          args.section_title as string,
          args.section_content as string,
          args.after_section as string | undefined,
        );
        return 'Section added successfully.';

      case 'get_stock_price':
        return await getStockPrice(args.ticker as string);

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function getStockPrice(ticker: string): Promise<string> {
  const apiKey = process.env.FINANCE_API_KEY;
  if (!apiKey) return 'Finance API not configured.';

  const [quoteRes, profileRes] = await Promise.all([
    fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${apiKey}`),
    fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${apiKey}`),
  ]);
  const quote = await quoteRes.json() as { c?: number; pc?: number; t?: number };
  const profile = await profileRes.json() as { name?: string; marketCapitalization?: number };

  const price = quote.c;
  const name = profile.name || ticker;
  const mcap = profile.marketCapitalization;

  const parts = [`${name} (${ticker})`];
  if (typeof price === 'number' && price > 0) parts.push(`Price: $${price.toFixed(2)}`);
  if (typeof mcap === 'number') {
    const val = mcap * 1_000_000;
    if (val >= 1e12) parts.push(`Market Cap: $${(val / 1e12).toFixed(2)}T`);
    else if (val >= 1e9) parts.push(`Market Cap: $${(val / 1e9).toFixed(2)}B`);
    else parts.push(`Market Cap: $${(val / 1e6).toFixed(2)}M`);
  }
  if (typeof quote.pc === 'number' && typeof price === 'number' && quote.pc > 0) {
    const change = ((price - quote.pc) / quote.pc * 100).toFixed(2);
    parts.push(`Change: ${Number(change) >= 0 ? '+' : ''}${change}%`);
  }
  return parts.join(' | ');
}

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Junior, a friendly and capable AI assistant in a Lark group chat.

You have access to tools for:
- **Project management (Meego)**: List features, check status, search features, create new features, complete workflow nodes
- **Documents (Lark)**: Read, edit sections, and add sections to Lark documents; create PRD from template
- **Finance**: Get stock prices and market data

Behavior guidelines:
- Be concise and natural in conversation. Keep replies short unless detail is needed.
- When casual, be witty and friendly. When serious, be analytical and precise.
- Use tools proactively when the user's request involves project data, documents, or stock info.
- When creating features, always create a PRD unless the user says not to.
- When showing feature info, include relevant links (Meego, PRD).
- If a question is ambiguous, ask for clarification before taking action.
- You can handle both English and Chinese messages.
- Don't apologize excessively. Just do the thing.`;

// ─── Main chat function ──────────────────────────────────────────────────────

export async function chat(history: ChatMessage[], userMessage: string): Promise<string> {
  const contents = history.map(m => ({
    role: m.role,
    parts: [{ text: m.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: userMessage }] });

  let response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: tools }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
    },
  });

  // Handle multi-turn function calling (up to 5 rounds)
  for (let i = 0; i < 5; i++) {
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const functionCalls = parts.filter(p => p.functionCall);
    if (functionCalls.length === 0) break;

    // Execute all function calls
    const functionResponses = await Promise.all(
      functionCalls.map(async (p) => {
        const fc = p.functionCall!;
        const name = fc.name ?? 'unknown';
        const result = await executeTool(name, (fc.args ?? {}) as Record<string, unknown>);
        return { name, response: { result } };
      }),
    );

    // Add the assistant's function call and results to contents
    contents.push({
      role: 'model',
      parts: parts.map(p => {
        if (p.functionCall) return { functionCall: p.functionCall } as unknown as { text: string };
        return { text: p.text ?? '' };
      }),
    });
    contents.push({
      role: 'user',
      parts: functionResponses.map(fr => ({
        functionResponse: fr,
      })) as unknown as Array<{ text: string }>,
    });

    // Get next response
    response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: tools }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
      },
    });
  }

  return response.text ?? 'No response generated.';
}
