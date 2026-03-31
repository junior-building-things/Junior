const LARK_BASE_URL = process.env.LARK_BASE_URL ?? 'https://open.larkoffice.com';
const LARK_APP_ID = process.env.LARK_APP_ID!;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET!;
const LARK_BOT_OPEN_ID = process.env.LARK_BOT_OPEN_ID;

// ─── Token cache ─────────────────────────────────────────────────────────────

let cachedToken = '';
let tokenExpiresAt = 0;

export async function getTenantToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const res = await fetch(`${LARK_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }),
  });
  const data = await res.json() as { tenant_access_token: string; expire?: number };
  cachedToken = data.tenant_access_token;
  tokenExpiresAt = Date.now() + (data.expire ?? 7200) * 1000;
  return cachedToken;
}

// ─── Message sending ─────────────────────────────────────────────────────────

export async function sendMessage(chatId: string, text: string): Promise<void> {
  const token = await getTenantToken();
  await fetch(`${LARK_BASE_URL}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
}

export async function sendReply(
  messageId: string,
  text: string,
  mentionOpenId?: string,
  mentionName?: string,
): Promise<void> {
  const token = await getTenantToken();
  const content = mentionOpenId
    ? `<at user_id="${mentionOpenId}">${mentionName ?? 'there'}</at> ${text}`
    : text;

  await fetch(`${LARK_BASE_URL}/open-apis/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msg_type: 'text',
      content: JSON.stringify({ text: content }),
    }),
  });
}

export async function sendCardMessage(chatId: string, title: string, markdown: string): Promise<void> {
  const token = await getTenantToken();
  const card = {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: title } },
    elements: [{ tag: 'markdown', content: markdown }],
  };
  await fetch(`${LARK_BASE_URL}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });
}

export async function reactToMessage(messageId: string, emoji: string): Promise<void> {
  const token = await getTenantToken();
  await fetch(`${LARK_BASE_URL}/open-apis/im/v1/messages/${messageId}/reactions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction_type: { emoji_type: emoji } }),
  }).catch(() => {}); // best-effort
}

// ─── Should reply check ──────────────────────────────────────────────────────

export function shouldReply(event: Record<string, unknown>): boolean {
  const message = event.message as Record<string, unknown> | undefined;
  const contentObj = JSON.parse((message?.content as string) ?? '{}');
  const mentions: Array<{ id?: { open_id?: string } }> = (message?.mentions ?? contentObj?.mentions ?? []) as Array<{ id?: { open_id?: string } }>;

  if (LARK_BOT_OPEN_ID) {
    return mentions.some(m => m.id?.open_id === LARK_BOT_OPEN_ID);
  }
  return mentions.length > 0;
}

// ─── Text sanitization ──────────────────────────────────────────────────────

export function sanitizeText(text: string): string {
  let t = (text ?? '').trim();
  if (!t) return t;
  t = t.replace(/@_user_\d+/g, '');
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}

// ─── Document helpers ────────────────────────────────────────────────────────

interface LarkBlock {
  block_id: string;
  block_type: number;
  children?: string[];
  text?: { elements: Array<{ text_run?: { content: string; text_element_style?: Record<string, unknown> } }> };
  table_cell?: { row_index: number; col_index: number };
}

function blockText(b: LarkBlock): string {
  return (b.text?.elements ?? []).map(e => e.text_run?.content ?? '').join('');
}

const HEADING_TYPES = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11]);

async function getDocBlocks(docId: string, token: string): Promise<LarkBlock[]> {
  const res = await fetch(
    `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks?page_size=500&document_revision_id=-1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json() as { code: number; data?: { items?: LarkBlock[] } };
  if (data.code !== 0) throw new Error(`get_blocks error ${data.code}`);
  return data.data?.items ?? [];
}

async function batchUpdateBlocks(
  docId: string,
  requests: Array<{ block_id: string; update_text_elements: { elements: Array<{ text_run: { content: string; text_element_style: Record<string, unknown> } }> } }>,
  token: string,
): Promise<void> {
  if (requests.length === 0) return;
  const res = await fetch(
    `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks/batch_update`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests, document_revision_id: -1 }),
    },
  );
  const data = await res.json() as { code: number; msg?: string };
  if (data.code !== 0) throw new Error(`update_blocks error ${data.code}: ${data.msg}`);
}

async function resolveDocId(url: string): Promise<string> {
  const wikiMatch = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikiMatch) {
    const token = await getTenantToken();
    const res = await fetch(`${LARK_BASE_URL}/open-apis/wiki/v2/spaces/get_node?token=${wikiMatch[1]}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as { code: number; data?: { node?: { obj_token?: string } } };
    if (data.code !== 0) throw new Error(`Wiki node error ${data.code}`);
    return data.data?.node?.obj_token ?? '';
  }
  const docxMatch = url.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docxMatch) return docxMatch[1];
  throw new Error('Invalid Lark doc URL');
}

export async function readDocContent(docUrl: string): Promise<string> {
  const docId = await resolveDocId(docUrl);
  const token = await getTenantToken();
  const blocks = await getDocBlocks(docId, token);
  const byId = new Map(blocks.map(b => [b.block_id, b]));

  const pageBlock = blocks.find(b => b.block_type === 1);
  if (!pageBlock?.children) return '(empty document)';

  const lines: string[] = [];
  for (const childId of pageBlock.children) {
    const b = byId.get(childId);
    if (!b) continue;
    const text = blockText(b);
    if (!text.trim()) continue;
    if (HEADING_TYPES.has(b.block_type)) {
      lines.push(`${'#'.repeat(b.block_type - 2)} ${text}`);
    } else {
      lines.push(text);
    }
  }
  return lines.join('\n') || '(empty document)';
}

export async function editDocSection(docUrl: string, sectionHeading: string, newContent: string): Promise<void> {
  const docId = await resolveDocId(docUrl);
  const token = await getTenantToken();
  const blocks = await getDocBlocks(docId, token);
  const byId = new Map(blocks.map(b => [b.block_id, b]));

  const pageBlock = blocks.find(b => b.block_type === 1);
  if (!pageBlock?.children) throw new Error('Empty document');

  const topLevel = pageBlock.children.map(id => byId.get(id)).filter((b): b is LarkBlock => !!b);

  let found = false;
  for (const block of topLevel) {
    if (HEADING_TYPES.has(block.block_type)) {
      if (blockText(block).toLowerCase().includes(sectionHeading.toLowerCase())) {
        found = true;
      } else if (found) {
        break;
      }
    } else if (found && block.block_type === 2) {
      await batchUpdateBlocks(docId, [{
        block_id: block.block_id,
        update_text_elements: { elements: [{ text_run: { content: newContent, text_element_style: {} } }] },
      }], token);
      return;
    }
  }
  throw new Error(`Section "${sectionHeading}" not found`);
}

export async function addDocSection(
  docUrl: string,
  sectionTitle: string,
  sectionContent: string,
  afterSection?: string,
): Promise<void> {
  const docId = await resolveDocId(docUrl);
  const token = await getTenantToken();
  const blocks = await getDocBlocks(docId, token);

  const pageBlock = blocks.find(b => b.block_type === 1);
  if (!pageBlock) throw new Error('Empty document');

  let insertIndex = -1;
  if (afterSection && pageBlock.children) {
    const byId = new Map(blocks.map(b => [b.block_id, b]));
    const topLevel = pageBlock.children.map(id => byId.get(id)).filter((b): b is LarkBlock => !!b);
    let foundTarget = false;
    for (let i = 0; i < topLevel.length; i++) {
      if (HEADING_TYPES.has(topLevel[i].block_type)) {
        if (blockText(topLevel[i]).toLowerCase().includes(afterSection.toLowerCase())) {
          foundTarget = true;
        } else if (foundTarget) {
          insertIndex = i;
          break;
        }
      }
    }
  }

  const body: Record<string, unknown> = {
    children: [
      { block_type: 4, heading2: { elements: [{ text_run: { content: sectionTitle } }] } },
      { block_type: 2, text: { elements: [{ text_run: { content: sectionContent } }] } },
    ],
  };
  if (insertIndex >= 0) body.index = insertIndex;

  const res = await fetch(
    `${LARK_BASE_URL}/open-apis/docx/v1/documents/${docId}/blocks/${pageBlock.block_id}/children?document_revision_id=-1`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json() as { code: number; msg?: string };
  if (data.code !== 0) throw new Error(`Create blocks error ${data.code}: ${data.msg}`);
}

// ─── Copy PRD template ──────────────────────────────────────────────────────

const WIKI_NODE_TOKEN = 'RUOXwaQVaiPKAOkjoywcTRdynuf';

export async function copyPrdTemplate(featureName: string, description?: string): Promise<string> {
  const token = await getTenantToken();

  // Get wiki node obj_token
  const nodeRes = await fetch(`${LARK_BASE_URL}/open-apis/wiki/v2/spaces/get_node?token=${WIKI_NODE_TOKEN}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const nodeData = await nodeRes.json() as { code: number; data?: { node?: { obj_token?: string; space_id?: string } } };
  if (nodeData.code !== 0) throw new Error(`Wiki node error ${nodeData.code}`);
  const objToken = nodeData.data?.node?.obj_token ?? '';
  const spaceId = nodeData.data?.node?.space_id ?? '';

  // Copy the doc
  const copyRes = await fetch(`${LARK_BASE_URL}/open-apis/drive/v1/files/${objToken}/copy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `[PRD] ${featureName}`, type: 'docx' }),
  });
  const copyData = await copyRes.json() as { code: number; data?: { file?: { token?: string; url?: string } } };
  if (copyData.code !== 0) throw new Error(`Copy PRD error ${copyData.code}`);

  const newDocToken = copyData.data?.file?.token ?? '';
  const prdUrl = copyData.data?.file?.url ?? `https://bytedance.sg.larkoffice.com/docx/${newDocToken}`;

  // Update the feature name in the doc title block
  if (newDocToken) {
    try {
      const blocks = await getDocBlocks(newDocToken, token);
      const titleBlock = blocks.find(b => b.block_type === 2 && blockText(b).includes('Feature Name'));
      if (titleBlock) {
        await batchUpdateBlocks(newDocToken, [{
          block_id: titleBlock.block_id,
          update_text_elements: { elements: [{ text_run: { content: featureName, text_element_style: {} } }] },
        }], token);
      }
    } catch { /* best effort */ }
  }

  return prdUrl;
}
