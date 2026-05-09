import { Type, FunctionDeclaration } from '@google/genai';

/**
 * Junior's function-calling tool definitions, passed to Gemini via
 * `config.tools` on every chat session. Imported by lib/gemini.ts (chat
 * runtime) and app/api/tools/route.ts (read-only listing endpoint that
 * Hamlet's Junior Context tab fetches).
 */
export const tools: FunctionDeclaration[] = [
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
    name: 'get_feature_by_doc_url',
    description: 'Get enriched feature data (PM, Tech Owner, team roster, status, links, risk, version) by a Lark document URL — typically a PRD URL stored on the feature. Use whenever the user asks about a feature using a Lark doc/wiki URL — e.g. "who is the PM of https://bytedance.sg.larkoffice.com/docx/...". This is the doc-URL counterpart to get_feature_status (which is keyed by Meego URL); pick this when the URL is larkoffice.com/docx or larkoffice.com/wiki and the question is about the feature, NOT about the doc body content. Use read_document only when the user wants to read or summarize the doc itself.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        doc_url: { type: Type.STRING, description: 'Lark document URL (docx or wiki)' },
      },
      required: ['doc_url'],
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
    name: 'set_feature_link',
    description: 'Set or update the Figma, Libra, or AB Report link on a feature in Hamlet. Use when the user says things like "update the figma link for feature X with ...", "add this ab report link for feature Y ...", "set libra for this feature to ...". The link is saved and protected from sync overwrites.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        feature_query: { type: Type.STRING, description: 'Feature name keyword(s) to find the feature in Hamlet (e.g. "ai self mix studio"). If the user said "this feature" and you have CURRENT FEATURE CONTEXT, use that feature\'s name.' },
        link_type: { type: Type.STRING, description: 'One of: figma, libra, ab' },
        url: { type: Type.STRING, description: 'The full URL to save' },
      },
      required: ['feature_query', 'link_type', 'url'],
    },
  },
  {
    name: 'remember_preference',
    description: 'Remember a user-stated preference by appending it to preferences.md (which gets loaded into your system prompt on every chat). Use this whenever the user says things like "from now on…", "going forward…", "always…", "remember to…", "in the future…", or any clear standing instruction about how you should behave. Phrase the preference as a concise instruction in second person ("Always use bullet lists when…", "Default to formal tone when…").',
    parameters: {
      type: Type.OBJECT,
      properties: {
        preference: { type: Type.STRING, description: 'The preference, written as a clear standing instruction. One sentence is ideal; multiple sentences OK if needed for clarity.' },
      },
      required: ['preference'],
    },
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
