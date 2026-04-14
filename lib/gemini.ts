import { GoogleGenAI, Type, FunctionCallingConfigMode, FunctionDeclaration } from '@google/genai';
import { ChatMessage } from './types';
import * as meego from './meego';
import * as lark from './lark';
import { loadHamletFeatures, findFeature, formatFeature } from './hamlet-cache';

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
    description: 'Get all available information about a feature by its Meego URL — status, priority, PRD, target version, team members, workflow nodes, custom fields, dates, and more. Use for any question about a Meego feature.',
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
        description: { type: Type.STRING, description: 'Brief description of the feature' },
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
    name: 'rename_document_section',
    description: 'Rename a section heading in a Lark document.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        doc_url: { type: Type.STRING, description: 'Lark document URL' },
        old_heading: { type: Type.STRING, description: 'Current heading text to find' },
        new_heading: { type: Type.STRING, description: 'New heading text to replace it with' },
      },
      required: ['doc_url', 'old_heading', 'new_heading'],
    },
  },
  {
    name: 'comment_document',
    description: 'Add a comment to a Lark document, optionally referencing a specific section.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        doc_url: { type: Type.STRING, description: 'Lark document URL' },
        content: { type: Type.STRING, description: 'Comment text' },
        section: { type: Type.STRING, description: 'Optional: section heading to quote in the comment' },
      },
      required: ['doc_url', 'content'],
    },
  },
  {
    name: 'list_document_comments',
    description: 'List comments on a Lark document, optionally filtered by search text.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        doc_url: { type: Type.STRING, description: 'Lark document URL' },
        search_text: { type: Type.STRING, description: 'Optional: filter comments containing this text' },
      },
      required: ['doc_url'],
    },
  },
  {
    name: 'reply_to_comment',
    description: 'Reply to an existing comment on a Lark document.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        doc_url: { type: Type.STRING, description: 'Lark document URL' },
        comment_id: { type: Type.STRING, description: 'The comment ID to reply to' },
        reply_text: { type: Type.STRING, description: 'Reply text' },
      },
      required: ['doc_url', 'comment_id', 'reply_text'],
    },
  },
  {
    name: 'duplicate_document',
    description: 'Duplicate/copy a Lark document. Returns the new document URL.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        doc_url: { type: Type.STRING, description: 'Lark document URL to copy' },
        new_name: { type: Type.STRING, description: 'Optional: name for the copied document' },
      },
      required: ['doc_url'],
    },
  },
  {
    name: 'get_package_qr',
    description: 'Get the latest package download URL (APK/IPA) for a feature by searching its Lark group chat messages. Requires feature name and optionally Meego URL to find the right chat.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        feature_name: { type: Type.STRING, description: 'Feature name to search for the group chat' },
        meego_url: { type: Type.STRING, description: 'Optional: Meego URL to match chat by work item ID' },
      },
      required: ['feature_name'],
    },
  },
  {
    name: 'update_feature',
    description: 'Update a feature\'s name, PRD URL, or priority in Meego.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        project_key: { type: Type.STRING, description: 'Meego project key (e.g. "TikTok")' },
        work_item_id: { type: Type.STRING, description: 'The work item ID number' },
        name: { type: Type.STRING, description: 'New feature name' },
        prd: { type: Type.STRING, description: 'New PRD URL' },
        priority: { type: Type.STRING, description: 'New priority (P0-P3)' },
      },
      required: ['project_key', 'work_item_id'],
    },
  },
  {
    name: 'search_feature_chat',
    description: 'Search a feature\'s Lark group chat for specific content — Libra/AB experiment links, recent discussions, decisions, or any keyword. Searches the last 30 days of messages including thread replies. Use when looking for links or info that was shared in the chat.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        feature_name: { type: Type.STRING, description: 'Feature name to find the group chat' },
        search_term: { type: Type.STRING, description: 'Keyword to search for (e.g. "libra", "blocker", "figma", "deadline")' },
        meego_url: { type: Type.STRING, description: 'Optional: Meego URL to match chat by work item ID' },
      },
      required: ['feature_name', 'search_term'],
    },
  },
  {
    name: 'search_lark_drive',
    description: 'Search Lark Drive for documents matching a query — finds AB reports, analysis docs, design specs, etc. Returns document titles and URLs. Use when looking for AB experiment reports or other docs related to a feature.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Search query (e.g. "AB Report Photo Comment Sticker")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_hamlet_feature',
    description: 'Get enriched feature data from the Hamlet cache — includes risk level, risk notes, version history, links (Figma, Libra, AB report, PRD, compliance), and full team roster. FASTER than Meego calls and includes data Meego doesn\'t have (risk assessment, version change history). Use this FIRST before get_feature_status for any feature question. Search by partial name, keywords, or abbreviation.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Feature name or keywords to search for (e.g. "ai self mix studio", "photo comment sticker")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_hamlet_overview',
    description: 'Get all features from the Hamlet cache with key details (name, status, priority, version, risk, tech owner). Use for ANY question that involves listing, filtering, or counting features — e.g. "list ongoing features", "what are my P2 features", "which features is Kyle tech owner of", "any high risk features", "features in AB Testing".',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'whoami',
    description: 'Get the current user\'s Lark identity info (open_id, name). Use when the user asks "who am I", "what\'s my open id", or similar.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'summarize_conversations',
    description: 'Fetch and summarize all Lark conversations from the last N days. Includes all DM chats and group chats where the user sent a message or was mentioned. Use when the user asks to summarize recent messages, conversations, or chats.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        days: { type: Type.NUMBER, description: 'Number of days to look back: 1, 2, or 7. Default 1.' },
      },
    },
  },
];

// ─── Tool execution ──────────────────────────────────────────────────────────

interface ChatContext { senderOpenId?: string; senderName?: string }

async function executeTool(name: string, args: Record<string, unknown>, ctx: ChatContext = {}): Promise<string> {
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
        const featureName = args.name as string;
        const description = (args.description as string) || '';
        const result = await meego.createFeature(featureName, priority as 'P0' | 'P1' | 'P2' | 'P3');
        let prdUrl = '';
        if (args.create_prd !== false) {
          try {
            prdUrl = await lark.copyPrdTemplate(featureName);
          } catch (e) {
            console.error('PRD creation failed:', e);
          }
        }

        // Send compliance card to the compliance group chat
        try {
          await lark.sendComplianceCard({
            featureName,
            prdUrl,
            description,
            priority,
            meegoUrl: result.meegoUrl,
          });
        } catch (e) {
          console.error('Compliance card failed:', e);
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

      case 'rename_document_section':
        await lark.renameDocSection(args.doc_url as string, args.old_heading as string, args.new_heading as string);
        return 'Section renamed successfully.';

      case 'comment_document':
        await lark.addDocComment(args.doc_url as string, args.content as string, args.section as string | undefined);
        return 'Comment added successfully.';

      case 'list_document_comments': {
        const comments = await lark.listDocComments(args.doc_url as string, args.search_text as string | undefined);
        if (comments.length === 0) return 'No comments found.';
        return comments.map(c =>
          `[${c.commentId}] ${c.quote ? `"${c.quote.slice(0, 50)}" — ` : ''}${c.content}${c.replies.length > 0 ? ` (${c.replies.length} replies)` : ''}`
        ).join('\n');
      }

      case 'reply_to_comment':
        await lark.replyToComment(args.doc_url as string, args.comment_id as string, args.reply_text as string);
        return 'Reply added successfully.';

      case 'duplicate_document': {
        const newUrl = await lark.duplicateDoc(args.doc_url as string, args.new_name as string | undefined);
        return `Document duplicated: ${newUrl}`;
      }

      case 'get_package_qr': {
        const chatId = await lark.joinFeatureChat(args.feature_name as string, args.meego_url as string | undefined);
        if (!chatId) return `Could not find a group chat for "${args.feature_name}".`;
        const result = await lark.getPackageQrUrl(chatId);
        if (!result) return 'No recent package release found in the chat.';
        return `Latest package download URL: ${result.downloadUrl}`;
      }

      case 'update_feature':
        return await meego.updateFeatureFields(
          args.project_key as string,
          args.work_item_id as string,
          { name: args.name as string | undefined, prd: args.prd as string | undefined, priority: args.priority as string | undefined },
        );


      case 'search_feature_chat': {
        const chatId = await lark.joinFeatureChat(
          args.feature_name as string,
          args.meego_url as string | undefined,
        );
        if (!chatId) return `Could not find a group chat for "${args.feature_name}".`;
        const token = await lark.getTenantToken();
        const nowSec = Math.floor(Date.now() / 1000);
        const sinceSec = nowSec - 30 * 24 * 60 * 60; // 30 days ago
        const messages = await lark.listChatMessages(chatId, sinceSec, nowSec, token);
        const term = (args.search_term as string).toLowerCase();
        const matches = messages
          .filter(m => m.content.toLowerCase().includes(term))
          .slice(0, 10)
          .map(m => {
            const time = m.create_time ? new Date(Number(m.create_time) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
            return `${time}: ${m.content.slice(0, 300)}`;
          });
        if (matches.length === 0) return `No messages containing "${args.search_term}" found in the last 30 days.`;
        return `Found ${matches.length} message(s) mentioning "${args.search_term}":\n${matches.join('\n')}`;
      }

      case 'search_lark_drive': {
        const token = await lark.getTenantToken();
        const res = await fetch('https://open.larksuite.com/open-apis/suite/docs-api/search/object', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ search_key: args.query as string, count: 10, offset: 0, docs_types: ['doc', 'docx', 'sheet', 'bitable'] }),
        });
        const data = await res.json() as { code: number; data?: { docs_entities?: Array<{ docs_token: string; docs_type: string; title: string }> } };
        if (data.code !== 0) return 'Lark Drive search failed.';
        const docs = data.data?.docs_entities ?? [];
        if (docs.length === 0) return `No documents found for "${args.query}".`;
        return docs.map(d => `${d.title}: https://bytedance.sg.larkoffice.com/${d.docs_type}/${d.docs_token}`).join('\n');
      }

      case 'get_hamlet_feature': {
        const features = await loadHamletFeatures();
        const match = findFeature(features, args.query as string);
        if (!match) return `No feature found matching "${args.query}".`;
        return formatFeature(match);
      }

      case 'get_hamlet_overview': {
        const features = await loadHamletFeatures();
        const lines = [`Total features: ${features.length}`, ''];
        // Group by status, each feature as a compact one-liner
        const byStatus: Record<string, typeof features> = {};
        for (const f of features) (byStatus[f.status] ??= []).push(f);
        for (const [status, group] of Object.entries(byStatus)) {
          lines.push(`${status} (${group.length}):`);
          for (const f of group) {
            const parts = [f.name];
            if (f.priority) parts.push(`[${f.priority}]`);
            if (f.iosVersion) parts.push(`v${f.iosVersion}`);
            if (f.riskLevel) parts.push(`risk:${f.riskLevel === 'red' ? 'high' : f.riskLevel === 'yellow' ? 'medium' : 'low'}`);
            if (f.techOwner) parts.push(`tech:${f.techOwner}`);
            lines.push(`  - ${parts.join(' | ')}`);
          }
          lines.push('');
        }
        return lines.join('\n');
      }

      case 'whoami':
        return JSON.stringify({ open_id: ctx.senderOpenId ?? 'unknown', name: ctx.senderName ?? 'unknown' });

      case 'summarize_conversations': {
        const userToken = await lark.getUserToken();
        const userOpenId = process.env.LARK_USER_OPEN_ID;
        if (!userToken) return 'Lark user token not configured. Set LARK_USER_TOKEN and LARK_REFRESH_TOKEN.';
        if (!userOpenId) return 'User open ID not configured (LARK_USER_OPEN_ID).';

        const days = Math.min(Math.max(Math.round(Number(args.days) || 1), 1), 7);
        const rawConversations = await lark.fetchRecentConversations(userToken, userOpenId, days);
        if (rawConversations.startsWith('No ')) return rawConversations;

        const summaryResponse = await ai.models.generateContent({
          model: MODEL,
          contents: [{ role: 'user', parts: [{ text: rawConversations }] }],
          config: { systemInstruction: CONVERSATION_SUMMARY_PROMPT },
        });
        return summaryResponse.text ?? 'Could not generate summary.';
      }

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

// ─── Prompts ────────────────────────────────────────────────────────────────

const CONVERSATION_SUMMARY_PROMPT = `You are summarizing a user's Lark conversations from the past few days.

Rules:
- Group the summary by topics/themes (e.g. "Design Reviews", "Deployment Issues", "Product Decisions"), NOT by chat
- For each topic: provide a simple summary of what was discussed/aligned and who was involved
- For each topic: assess whether this workflow could feasibly be automated by AI, a Lark bot, or an agent. If yes, briefly suggest how
- Keep the original language of the messages (don't translate Chinese to English or vice versa)
- Skip trivial messages (greetings, emoji-only, thumbs up)
- Be concise and actionable`;

const SYSTEM_PROMPT = `You are Junior, a friendly and capable AI assistant in a Lark group chat.

You have access to tools for:
- **Hamlet cache (FASTEST)**: get_hamlet_feature and get_hamlet_overview — reads enriched feature data from Hamlet's cache including risk level, risk notes, version history, Figma/Libra/AB report links, and full team roster. ALWAYS try this first before calling Meego.
- **Project management (Meego)**: List features, check status, search features, create new features, complete workflow nodes, update feature fields (name, PRD, priority). Use as fallback when Hamlet cache doesn't have the data.
- **Documents (Lark)**: Read, edit sections, rename sections, add sections, add/list/reply to comments, duplicate documents, create PRD from template
- **Lark Drive search**: Find AB reports, analysis docs, or design specs by keyword
- **Chat search**: Search a feature's Lark group chat for specific content (Libra links, decisions, blockers)
- **Package builds**: Get the latest package download URL (APK/IPA) for a feature from its Lark group chat
- **Conversations**: Summarize all Lark conversations from the last 1, 2, or 7 days, grouped by topic with automation suggestions

Behavior guidelines:
- Be concise and natural in conversation. Keep replies short unless detail is needed.
- When casual, be witty and friendly. When serious, be analytical and precise.
- Use tools proactively when the user's request involves project data, documents, or stock info.
- When the user asks about a specific feature, ALWAYS use get_hamlet_feature first (fastest, has risk/links/team). Only fall back to get_feature_status or search_feature if the Hamlet cache doesn't have the info.
- When the user asks about "project status", "my features", "what am I working on", or similar — use get_hamlet_overview first for a quick summary, then get_my_features if more detail is needed.
- When creating features, always create a PRD unless the user says not to.
- When showing feature info, include relevant links (Meego, PRD).
- Only ask for clarification when you truly cannot proceed. Default to action — call a tool and show results rather than asking what the user means.
- You can handle both English and Chinese messages. Always reply in English.
- When Meego data contains Chinese (e.g. status "已上车", node names, field labels), always translate to English in your reply.
- Don't apologize excessively. Just do the thing.
- NEVER use italic formatting (*text*). Use **bold** for emphasis instead.
- When asked "what can you do" or "help", describe YOUR specific capabilities (Meego features, Lark docs, package builds, stock prices, conversation summaries). Never give a generic AI capabilities list.
- When the user asks to summarize conversations, messages, or chats from recent days/today/this week, use the summarize_conversations tool.`;

// ─── Main chat function ──────────────────────────────────────────────────────

const CHAT_TIMEOUT_MS = 30_000;

export async function chat(history: ChatMessage[], userMessage: string, ctx: ChatContext = {}): Promise<string> {
  // Abort the entire chat flow if it exceeds the timeout
  const abort = AbortSignal.timeout(CHAT_TIMEOUT_MS);

  // Filter out corrupted history pairs from previous failures
  const ERROR_PATTERNS = ['No response generated.', "couldn't retrieve", "don't have the necessary permissions", 'encountered an error', 'showing as'];
  const cleanHistory: ChatMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (!m.content) continue;
    if (m.role === 'model' && ERROR_PATTERNS.some(p => m.content.includes(p))) {
      // Also remove the preceding user message
      if (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role === 'user') {
        cleanHistory.pop();
      }
      continue;
    }
    cleanHistory.push(m);
  }
  const chatHistory = cleanHistory.map(m => ({
    role: m.role,
    parts: [{ text: m.content }],
  }));

  try {
    const chatSession = ai.chats.create({
      model: MODEL,
      history: chatHistory,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: tools }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
      },
    });

    let response = await chatSession.sendMessage({ message: userMessage });

    // Handle multi-turn function calling (up to 5 rounds)
    for (let i = 0; i < 5; i++) {
      if (abort.aborted) throw new DOMException('Timed out', 'TimeoutError');

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const functionCalls = parts.filter(p => p.functionCall);
      if (functionCalls.length === 0) break;

      // Execute all function calls
      const functionResponses = [];
      for (const p of functionCalls) {
        const fc = p.functionCall!;
        const name = fc.name ?? 'unknown';
        const result = await executeTool(name, (fc.args ?? {}) as Record<string, unknown>, ctx);
        let output: Record<string, unknown>;
        try { output = JSON.parse(result) as Record<string, unknown>; } catch { output = { text: result }; }
        functionResponses.push({ id: fc.id ?? '', name, response: output });
      }

      // Send function responses back via the chat session
      response = await chatSession.sendMessage({
        message: functionResponses.map(fr => ({
          functionResponse: fr,
        })),
      });
    }

    // Strip all italic markers while preserving bold (**text**)
    // 1. Shelter bold markers  2. Remove remaining *  3. Restore bold
    const text = response.text ?? 'No response generated.';
    return text.replace(/\*\*/g, '\x00').replace(/\*/g, '').replace(/\x00/g, '**');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return 'Sorry, that took too long. Try a simpler question or try again?';
    }
    throw err;
  }
}
