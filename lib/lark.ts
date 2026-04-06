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

// ─── User token (for reading user's chats) ──────────────────────────────────

let cachedUserToken = '';
let userTokenExpiresAt = 0;

// ─── Secret Manager helpers ─────────────────────────────────────────────────
// Store both access_token + refresh_token as JSON so new instances can resume
// without needing to refresh (which consumes the single-use refresh token).

const GCP_PROJECT = process.env.GCP_PROJECT ?? 'tiktok-im';
const SECRET_NAME = 'lark-refresh-token';

interface LarkTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix ms
}

async function getGcpAccessToken(): Promise<string> {
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function loadTokensFromSecret(): Promise<LarkTokens | null> {
  try {
    const gcpToken = await getGcpAccessToken();
    const url = `https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/${SECRET_NAME}/versions/latest:access`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${gcpToken}` } });
    const data = await res.json() as { payload?: { data?: string } };
    if (data.payload?.data) {
      return JSON.parse(Buffer.from(data.payload.data, 'base64').toString('utf-8')) as LarkTokens;
    }
  } catch { /* fall through */ }
  return null;
}

export async function saveTokensToSecret(tokens: LarkTokens): Promise<void> {
  try {
    const gcpToken = await getGcpAccessToken();
    const url = `https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/${SECRET_NAME}:addVersion`;
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { data: Buffer.from(JSON.stringify(tokens)).toString('base64') } }),
    });
  } catch (e) {
    console.error('Failed to save tokens:', e);
  }
}

export async function getUserToken(): Promise<string | null> {
  // Return in-memory cached token if still valid
  if (cachedUserToken && Date.now() < userTokenExpiresAt - 60_000) return cachedUserToken;

  // Load from Secret Manager (has both access + refresh token)
  const stored = await loadTokensFromSecret();

  // If stored access token is still valid, use it directly (no refresh needed)
  if (stored && Date.now() < stored.expires_at - 60_000) {
    cachedUserToken = stored.access_token;
    userTokenExpiresAt = stored.expires_at;
    console.log('User token loaded from secret (still valid)');
    return cachedUserToken;
  }

  // Access token expired — refresh it
  const refreshToken = stored?.refresh_token ?? process.env.LARK_REFRESH_TOKEN ?? '';
  if (refreshToken) {
    const res = await fetch(`${LARK_BASE_URL}/open-apis/authen/v1/oidc/refresh_access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await getTenantToken()}`,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const data = await res.json() as {
      code: number;
      data?: {
        access_token?: string;
        refresh_token?: string;
        expire_in?: number;
      };
    };
    if (data.code === 0 && data.data?.access_token) {
      cachedUserToken = data.data.access_token;
      userTokenExpiresAt = Date.now() + (data.data.expire_in ?? 7200) * 1000;
      // Save both tokens so next instance can use access token directly
      await saveTokensToSecret({
        access_token: cachedUserToken,
        refresh_token: data.data.refresh_token ?? refreshToken,
        expires_at: userTokenExpiresAt,
      });
      console.log('User token refreshed and saved to secret');
      return cachedUserToken;
    }
    console.error('User token refresh failed:', JSON.stringify(data).slice(0, 300));
  }

  return null;
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

// ─── Compliance card ────────────────────────────────────────────────────────

const COMPLIANCE_CHAT_ID = 'oc_d1f9b0ad6b325ef6699e0422fa1e8541';

export async function sendComplianceCard(params: {
  featureName: string;
  prdUrl: string;
  description: string;
  priority: string;
  meegoUrl: string;
}): Promise<void> {
  const { featureName, prdUrl, description, priority, meegoUrl } = params;
  const token = await getTenantToken();

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '🆕 New Feature — Compliance Review Needed' },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**Feature:** ${featureName}`,
          `**Priority:** ${priority}`,
          description ? `**Description:** ${description}` : '',
          `**Meego:** [Open in Meego](${meegoUrl})`,
          prdUrl ? `**PRD:** [Open PRD](${prdUrl})` : '**PRD:** Not created',
        ].filter(Boolean).join('\n'),
      },
    ],
  };

  await fetch(`${LARK_BASE_URL}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receive_id: COMPLIANCE_CHAT_ID,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });
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

// ─── Rename section ─────────────────────────────────────────────────────────

export async function renameDocSection(docUrl: string, oldHeading: string, newHeading: string): Promise<void> {
  const docId = await resolveDocId(docUrl);
  const token = await getTenantToken();
  const blocks = await getDocBlocks(docId, token);

  const pageBlock = blocks.find(b => b.block_type === 1);
  if (!pageBlock?.children) throw new Error('Empty document');

  const byId = new Map(blocks.map(b => [b.block_id, b]));
  const topLevel = pageBlock.children.map(id => byId.get(id)).filter((b): b is LarkBlock => !!b);

  for (const block of topLevel) {
    if (HEADING_TYPES.has(block.block_type) && blockText(block).toLowerCase().includes(oldHeading.toLowerCase())) {
      await batchUpdateBlocks(docId, [{
        block_id: block.block_id,
        update_text_elements: { elements: [{ text_run: { content: newHeading, text_element_style: {} } }] },
      }], token);
      return;
    }
  }
  throw new Error(`Section "${oldHeading}" not found`);
}

// ─── Document comments ──────────────────────────────────────────────────────

export async function addDocComment(docUrl: string, content: string, section?: string): Promise<void> {
  const docId = await resolveDocId(docUrl);
  const token = await getTenantToken();

  const elements: Array<{ type: string; text_run: { text: string } }> = [];

  if (section) {
    const blocks = await getDocBlocks(docId, token);
    const byId = new Map(blocks.map(b => [b.block_id, b]));
    const pageBlock = blocks.find(b => b.block_type === 1);
    if (pageBlock?.children) {
      const topLevel = pageBlock.children.map(id => byId.get(id)).filter((b): b is LarkBlock => !!b);
      let foundHeading = false;
      const sectionTexts: string[] = [];
      for (const block of topLevel) {
        if (HEADING_TYPES.has(block.block_type)) {
          if (foundHeading) break;
          if (blockText(block).toLowerCase().includes(section.toLowerCase())) foundHeading = true;
        } else if (foundHeading) {
          const t = blockText(block).trim();
          if (t) sectionTexts.push(t);
        }
      }
      const quoted = sectionTexts.join(' ').slice(0, 300);
      elements.push({ type: 'text_run', text_run: { text: quoted ? `Re: "${section}"\n> ${quoted}\n\n` : `Re: "${section}"\n\n` } });
    }
  }

  elements.push({ type: 'text_run', text_run: { text: content } });

  const res = await fetch(`${LARK_BASE_URL}/open-apis/drive/v1/files/${docId}/comments?file_type=docx`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reply_list: { replies: [{ content: { elements } }] } }),
  });
  const data = await res.json() as { code: number; msg?: string };
  if (data.code !== 0) throw new Error(`Comment error ${data.code}: ${data.msg}`);
}

export async function listDocComments(
  docUrl: string,
  searchText?: string,
): Promise<Array<{ commentId: string; quote: string; content: string; replies: Array<{ content: string }> }>> {
  const docId = await resolveDocId(docUrl);
  const token = await getTenantToken();

  const res = await fetch(`${LARK_BASE_URL}/open-apis/drive/v1/files/${docId}/comments?file_type=docx&page_size=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as {
    code: number; msg?: string;
    data?: { items?: Array<{
      comment_id: string;
      quote: string;
      reply_list?: { replies?: Array<{ content?: { elements?: Array<{ text_run?: { text?: string } }> } }> };
    }> };
  };
  if (data.code !== 0) throw new Error(`List comments error ${data.code}: ${data.msg}`);

  const items = (data.data?.items ?? []).map(c => {
    const replies = (c.reply_list?.replies ?? []).map(r =>
      ({ content: (r.content?.elements ?? []).map(e => e.text_run?.text ?? '').join('') })
    );
    return { commentId: c.comment_id, quote: c.quote ?? '', content: replies[0]?.content ?? '', replies: replies.slice(1) };
  });

  if (searchText) {
    const term = searchText.toLowerCase();
    return items.filter(c => c.quote.toLowerCase().includes(term) || c.content.toLowerCase().includes(term));
  }
  return items;
}

export async function replyToComment(docUrl: string, commentId: string, replyText: string): Promise<void> {
  const docId = await resolveDocId(docUrl);
  const token = await getTenantToken();

  const res = await fetch(
    `${LARK_BASE_URL}/open-apis/drive/v1/files/${docId}/comments/${commentId}/replies?file_type=docx`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { elements: [{ type: 'text_run', text_run: { text: replyText } }] } }),
    },
  );
  const data = await res.json() as { code: number; msg?: string };
  if (data.code !== 0) throw new Error(`Reply error ${data.code}: ${data.msg}`);
}

// ─── Duplicate document ─────────────────────────────────────────────────────

async function getRootFolderToken(token: string): Promise<string> {
  const res = await fetch(`${LARK_BASE_URL}/open-apis/drive/explorer/v2/root_folder/meta`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as { code: number; data?: { token: string } };
  if (data.code !== 0) throw new Error(`Root folder error ${data.code}`);
  return data.data!.token;
}

export async function duplicateDoc(docUrl: string, newName?: string): Promise<string> {
  const docId = await resolveDocId(docUrl);
  const token = await getTenantToken();
  const folderToken = await getRootFolderToken(token);

  const res = await fetch(`${LARK_BASE_URL}/open-apis/drive/v1/files/${docId}/copy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName ?? 'Copy', type: 'docx', folder_token: folderToken }),
  });
  const data = await res.json() as { code: number; data?: { file?: { token?: string; url?: string } } };
  if (data.code !== 0) throw new Error(`Copy error ${data.code}`);
  const fileToken = data.data?.file?.token ?? '';
  return data.data?.file?.url ?? `https://bytedance.sg.larkoffice.com/docx/${fileToken}`;
}

// ─── Feature chat + package QR ──────────────────────────────────────────────

export async function joinFeatureChat(featureName: string, meegoUrl?: string): Promise<string | null> {
  if (!featureName) return null;
  const botToken = await getTenantToken();

  const searchRes = await fetch(
    `${LARK_BASE_URL}/open-apis/im/v1/chats/search?query=${encodeURIComponent(featureName)}&page_size=20`,
    { headers: { Authorization: `Bearer ${botToken}` } },
  );
  const searchData = await searchRes.json() as {
    code: number; data?: { items?: Array<{ chat_id: string; name: string }> };
  };
  if (searchData.code !== 0) return null;

  const chats = searchData.data?.items ?? [];
  if (chats.length === 0) return null;

  const EXCLUDE = ['libra', 'checkpoint', '管控'];
  const candidates = chats.filter(c => !EXCLUDE.some(p => c.name.toLowerCase().includes(p)));

  const meegoId = meegoUrl?.match(/\/detail\/(\d+)/)?.[1] ?? '';
  let bestChat: { chat_id: string; name: string } | null = null;

  if (meegoId) {
    for (const c of candidates) {
      try {
        const infoRes = await fetch(`${LARK_BASE_URL}/open-apis/im/v1/chats/${c.chat_id}`, {
          headers: { Authorization: `Bearer ${botToken}` },
        });
        const infoData = await infoRes.json() as { code: number; data?: Record<string, unknown> };
        if (infoData.code === 0 && String(infoData.data?.description ?? '').includes(meegoId)) {
          bestChat = c;
          break;
        }
      } catch { /* skip */ }
    }
  }

  if (!bestChat && candidates.length > 0) bestChat = candidates[0];
  if (!bestChat) return null;

  // Try to join the chat
  await fetch(
    `${LARK_BASE_URL}/open-apis/im/v1/chats/${bestChat.chat_id}/members?member_id_type=app_id`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_list: [LARK_APP_ID] }),
    },
  ).catch(() => {});

  return bestChat.chat_id;
}

export async function getPackageQrUrl(chatId: string): Promise<{ downloadUrl: string } | null> {
  const token = await getTenantToken();

  const res = await fetch(
    `${LARK_BASE_URL}/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=50&sort_type=ByCreateTimeDesc`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json() as {
    code: number; data?: { items?: Array<{ body?: { content?: string } }> };
  };
  if (data.code !== 0) return null;

  for (const msg of data.data?.items ?? []) {
    const content = msg.body?.content ?? '';
    if (!content.includes('released') && !content.includes('artifacts') && !content.includes('已发布')) continue;

    const patterns = [
      /https:\/\/ttidevops[^"'\s]+package_id=\d+/,
      /https:\/\/voffline\.byted\.org\/download[^"'\s]+\.(?:apk|ipa)/,
      /https:\/\/[^"'\s]+\.(?:apk|ipa)/,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        const url = match[0];
        if (/ttlite|lite_android|lite_ios|app-lite/i.test(url)) continue;
        return { downloadUrl: url };
      }
    }
  }
  return null;
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

// ─── Conversation summary ───────────────────────────────────────────────────

export async function listUserChats(userToken: string): Promise<Array<{ chat_id: string; name: string; chat_mode?: string; [key: string]: unknown }>> {
  const chats: Array<{ chat_id: string; name: string; chat_mode?: string; [key: string]: unknown }> = [];
  let pageToken = '';

  for (let page = 0; page < 2; page++) {
    const url = `${LARK_BASE_URL}/open-apis/im/v1/chats?page_size=100&user_id_type=open_id${pageToken ? `&page_token=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${userToken}` } });
    const data = await res.json() as {
      code: number;
      data?: { items?: Array<{ chat_id: string; name: string; chat_mode?: string; [key: string]: unknown }>; page_token?: string; has_more?: boolean };
    };
    console.log(`listUserChats page ${page}: code=${data.code}, items=${data.data?.items?.length ?? 0}`, data.code !== 0 ? JSON.stringify(data).slice(0, 300) : '');
    if (data.code !== 0) break;
    chats.push(...(data.data?.items ?? []));
    if (!data.data?.has_more) break;
    pageToken = data.data?.page_token ?? '';
  }

  return chats;
}

export async function listChatMessages(
  chatId: string,
  startTime: number,
  endTime: number,
  userToken: string,
): Promise<Array<{ sender_id: string; content: string; create_time: string; mentions: string[] }>> {
  const messages: Array<{ sender_id: string; content: string; create_time: string; mentions: string[] }> = [];
  let pageToken = '';

  for (let page = 0; page < 4; page++) {
    const url = `${LARK_BASE_URL}/open-apis/im/v1/messages?container_id_type=chat&container_id=${chatId}&start_time=${startTime}&end_time=${endTime}&page_size=50&sort_type=ByCreateTimeAsc${pageToken ? `&page_token=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${userToken}` } });
    const data = await res.json() as {
      code: number;
      data?: {
        items?: Array<{
          sender: { sender_id: string };
          body?: { content?: string };
          msg_type: string;
          create_time: string;
          mentions?: Array<{ id: { open_id?: string } }>;
        }>;
        page_token?: string;
        has_more?: boolean;
      };
    };
    if (data.code !== 0) {
      console.error(`listChatMessages error for ${chatId}: ${data.code}`, JSON.stringify(data).slice(0, 200));
      break;
    }

    for (const msg of data.data?.items ?? []) {
      let content = '';
      const rawContent = msg.body?.content ?? '';
      try {
        if (msg.msg_type === 'text') {
          content = (JSON.parse(rawContent) as { text?: string }).text ?? '';
        } else if (msg.msg_type === 'interactive') {
          const card = JSON.parse(rawContent) as { header?: { title?: { content?: string } } };
          content = `[card: ${card.header?.title?.content ?? 'untitled'}]`;
        } else {
          content = `[${msg.msg_type}]`;
        }
      } catch {
        content = rawContent || `[${msg.msg_type}]`;
      }

      const mentions = (msg.mentions ?? []).map(m => m.id?.open_id ?? '').filter(Boolean);
      messages.push({ sender_id: msg.sender.sender_id, content, create_time: msg.create_time, mentions });
    }

    if (!data.data?.has_more) break;
    pageToken = data.data?.page_token ?? '';
  }

  return messages;
}

export async function fetchRecentConversations(userToken: string, userOpenId: string, days: number = 1): Promise<string> {
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - days * 86400;
  const botOpenId = process.env.LARK_BOT_OPEN_ID ?? '';

  const chats = await listUserChats(userToken);
  console.log(`Found ${chats.length} chats, modes:`, chats.slice(0, 5).map(c => `${c.name}(${c.chat_mode})`));
  if (chats.length === 0) return 'No chats found.';

  const results: Array<{ name: string; lines: string[] }> = [];
  let totalMessages = 0;
  let emptyChats = 0;

  // Fetch in batches of 5
  for (let i = 0; i < chats.length; i += 5) {
    const batch = chats.slice(i, i + 5);
    const batchResults = await Promise.all(
      batch.map(async (chat) => {
        try {
          const messages = await listChatMessages(chat.chat_id, startTime, endTime, userToken);
          return { chat, messages };
        } catch (e) {
          console.error(`Failed to fetch messages for ${chat.name}:`, e);
          return { chat, messages: [] };
        }
      }),
    );

    for (const { chat, messages } of batchResults) {
      totalMessages += messages.length;
      if (messages.length === 0) { emptyChats++; continue; }

      // Only include chats where the user sent a message
      if (!messages.some(m => m.sender_id === userOpenId)) continue;

      const lines = messages
        .filter(m => m.sender_id !== botOpenId)
        .map(m => {
          const time = new Date(Number(m.create_time) * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
          const who = m.sender_id === userOpenId ? 'You' : m.sender_id;
          return `[${time}] ${who}: ${m.content}`;
        });

      if (lines.length > 0) {
        results.push({ name: chat.name || chat.chat_id, lines });
      }
    }
  }

  console.log(`Stats: ${chats.length} chats, ${emptyChats} empty, ${totalMessages} total messages, ${results.length} matched`);
  if (results.length === 0) return `No conversations found in the last ${days} day(s).`;

  // Truncate if total messages exceed 2000
  let total = results.reduce((sum, r) => sum + r.lines.length, 0);
  if (total > 2000) {
    const perChat = Math.floor(2000 / results.length);
    for (const r of results) {
      if (r.lines.length > perChat) {
        r.lines = r.lines.slice(-perChat);
        r.lines.unshift('(earlier messages truncated)');
      }
    }
  }

  return results.map(r => `=== ${r.name} ===\n${r.lines.join('\n')}`).join('\n\n');
}
