import { Priority } from './types';

const MEEGO_MCP_URL = 'https://meego.larkoffice.com/mcp_server/v1';
const TIKTOK_PROJECT_KEY = '5f105019a8b9a853da64767f';

const NODE_TRANSLATIONS: Record<string, string> = {
  '产品需求准备': 'Requirements Prep',
  '产品线内初评': 'Initial Review',
  '技术评估&排优': 'Tech Assessment',
  '需求详评': 'Detailed Review',
  '需求评审': 'Requirements Review',
  '技术方案设计': 'Technical Design',
  'iOS 开发': 'iOS Development',
  'UI&UX验收': 'UI/UX Acceptance',
  'Server上线': 'Server Launch',
  'AB实验': 'AB Testing',
  '结束': 'Done',
  'PM验收': 'PM Acceptance',
  'PM走查': 'PM Walkthrough',
  '依赖判断': 'Dependency Check',
  '合规评估': 'Compliance Review',
};

const NODE_PRIORITY = [
  '产品需求准备', '产品线内初评', '技术评估&排优', '需求详评',
  '技术方案设计', 'iOS 开发', 'UI&UX验收', 'Server上线', 'AB实验', '结束',
];

const PRIORITY_TO_MEEGO: Record<Priority, string> = { P0: '0', P1: '1', P2: '2', P3: '3' };

function translateNode(node: string): string {
  return NODE_TRANSLATIONS[node] ?? node;
}

async function callMeegoMcp(toolName: string, args: Record<string, unknown>): Promise<string> {
  const token = process.env.MEEGO_USER_TOKEN;
  if (!token) throw new Error('MEEGO_USER_TOKEN not configured');

  const res = await fetch(MEEGO_MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mcp-Token': token },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  if (!res.ok) throw new Error(`Meego MCP HTTP error: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Meego MCP error: ${data.error.message}`);
  return data.result?.content?.[0]?.text ?? '';
}

function parseWorkItemField(raw: string, fieldName: string): string {
  const regex = new RegExp(`\\|\\s*${fieldName}\\s*\\|\\s*([^|\\n]+?)\\s*\\|`);
  const match = raw.match(regex);
  return match ? match[1].trim() : '';
}

function extractNames(value: string): string {
  if (!value || value === '未填写') return '';
  const names: string[] = [];
  const regex = /([^,(]+)\([^)]*\)/g;
  let m;
  while ((m = regex.exec(value)) !== null) {
    const name = m[1].trim();
    if (name) names.push(name);
  }
  return names.length > 0 ? names.join(', ') : value;
}

function parseRoleMember(raw: string, roleName: string): string {
  const escaped = roleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`"${escaped}":"([^"]+)"`);
  const match = raw.match(regex);
  return match ? extractNames(match[1]) : '';
}

function parseActiveNodes(raw: string): Array<{ key: string; name: string; owners: string }> {
  const section = raw.split('# 进行中的节点')[1] ?? '';
  return section
    .split('\n')
    .filter(l => l.startsWith('|') && !l.includes('---') && !l.includes('节点 ID'))
    .flatMap(line => {
      const parts = line.split('|').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 3) return [{ key: parts[0], name: parts[1], owners: parts[2] }];
      return [];
    });
}

function pickNode(nodes: Array<{ key: string; name: string }>): { key: string; name: string } | null {
  if (nodes.length === 0) return null;
  return nodes.slice().sort((a, b) => {
    const ia = NODE_PRIORITY.indexOf(a.name);
    const ib = NODE_PRIORITY.indexOf(b.name);
    return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  })[0];
}

// ─── Public API (called by Gemini tools) ─────────────────────────────────────

export async function getMyFeatures(): Promise<string> {
  const items: Array<{ name: string; id: number; node: string; project: string }> = [];
  let page = 1;

  while (true) {
    const raw = await callMeegoMcp('list_todo', { action: 'todo', page_num: page });
    const data = JSON.parse(raw) as {
      total: number;
      list: Array<{
        work_item_info: { work_item_id: number; work_item_name: string };
        project_key: string;
        node_info: { node_name: string };
      }>;
    };

    for (const item of data.list ?? []) {
      items.push({
        name: item.work_item_info.work_item_name,
        id: item.work_item_info.work_item_id,
        node: translateNode(item.node_info?.node_name ?? 'Unknown'),
        project: item.project_key,
      });
    }
    if (items.length >= data.total) break;
    page++;
  }

  if (items.length === 0) return 'No active features found.';

  return items.map(i =>
    `• ${i.name} (ID: ${i.id}) — Status: ${i.node} — [Meego](https://meego.larkoffice.com/${i.project}/story/detail/${i.id})`
  ).join('\n');
}

export async function getFeatureStatus(meegoUrl: string): Promise<string> {
  const raw = await callMeegoMcp('get_workitem_brief', { url: meegoUrl });
  // Return full MCP response — let Gemini extract whatever the user asked about
  return raw;
}

export async function searchFeature(query: string): Promise<string> {
  const MQL = `SELECT \`work_item_id\`, \`name\`, \`priority\`, \`wiki\` FROM \`TikTok\`.\`需求\` WHERE \`__PM\` = current_login_user()`;

  const raw = await callMeegoMcp('search_by_mql', {
    project_key: 'TikTok',
    mql: MQL,
  });

  const data = JSON.parse(raw) as {
    data: Record<string, Array<{
      moql_field_list: Array<{ key: string; value: { varchar_value?: string; long_value?: number; key_label_value?: { label: string } } }>;
    }>>;
  };

  const items = data.data?.['1'] ?? [];
  const lowerQuery = query.toLowerCase();

  const matches = items.filter(item => {
    const name = item.moql_field_list.find(f => f.key === 'name')?.value.varchar_value ?? '';
    return name.toLowerCase().includes(lowerQuery);
  });

  if (matches.length === 0) return `No features found matching "${query}".`;

  return matches.slice(0, 10).map(item => {
    const id = item.moql_field_list.find(f => f.key === 'work_item_id')?.value.long_value ?? '';
    const name = item.moql_field_list.find(f => f.key === 'name')?.value.varchar_value ?? '';
    const priority = item.moql_field_list.find(f => f.key === 'priority')?.value.key_label_value?.label ?? '';
    const prd = item.moql_field_list.find(f => f.key === 'wiki')?.value.varchar_value ?? '';
    return `• ${name} (${priority}) — ID: ${id}${prd ? ` — PRD: ${prd}` : ''} — [Meego](https://meego.larkoffice.com/TikTok/story/detail/${id})`;
  }).join('\n');
}

export async function createFeature(
  name: string,
  priority: Priority = 'P2',
): Promise<{ id: string; meegoUrl: string }> {
  const fields = [
    { field_key: 'template', field_value: '207989' },
    { field_key: 'name', field_value: name },
    { field_key: 'priority', field_value: PRIORITY_TO_MEEGO[priority] },
    { field_key: 'field_40694f', field_value: JSON.stringify([{ option_id: 'mn088uae2' }]) },
    { field_key: 'field_2177d5', field_value: 'true' },
    { field_key: 'field_894cbf', field_value: 'true' },
    { field_key: 'need_ab', field_value: 'true' },
    { field_key: 'field_391771', field_value: 'true' },
  ];

  const raw = await callMeegoMcp('create_workitem', {
    project_key: TIKTOK_PROJECT_KEY,
    work_item_type: 'story',
    fields,
  });

  let workItemId = '';
  try {
    const parsed = JSON.parse(raw);
    workItemId = String(parsed.work_item_id ?? parsed.data?.work_item_id ?? '');
  } catch { /* regex fallback */ }
  if (!workItemId) {
    const m = raw.match(/"?work_item_id"?\s*[:\s]+(\d+)/);
    if (m) workItemId = m[1];
  }
  if (!workItemId) throw new Error(`Could not parse work_item_id: ${raw}`);

  return {
    id: workItemId,
    meegoUrl: `https://meego.larkoffice.com/${TIKTOK_PROJECT_KEY}/story/detail/${workItemId}`,
  };
}

export async function completeNode(
  projectKey: string,
  workItemId: string,
  nodeKey: string,
): Promise<string> {
  const response = await callMeegoMcp('transition_node', {
    project_key: projectKey,
    work_item_type: 'story',
    work_item_id: workItemId,
    node_id: nodeKey,
    action: 'confirm',
  });
  const lower = response.toLowerCase();
  if (lower.includes('error') || lower.includes('fail') || lower.includes('不能')) {
    throw new Error(response.slice(0, 300));
  }
  return 'Node completed successfully.';
}

const PRIORITY_MAP: Record<string, string> = { P0: '0', P1: '1', P2: '2', P3: '3' };

export async function updateFeatureFields(
  projectKey: string,
  workItemId: string,
  fields: { name?: string; prd?: string; priority?: string },
): Promise<string> {
  const updates: { field_key: string; field_value: string }[] = [];
  if (fields.name) updates.push({ field_key: 'name', field_value: fields.name });
  if (fields.prd) updates.push({ field_key: 'wiki', field_value: fields.prd });
  if (fields.priority && PRIORITY_MAP[fields.priority]) updates.push({ field_key: 'priority', field_value: PRIORITY_MAP[fields.priority] });
  if (updates.length === 0) return 'No fields to update.';

  await callMeegoMcp('update_field', { project_key: projectKey, work_item_id: workItemId, fields: updates });
  return 'Feature updated successfully.';
}

/** Fetch basic feature info for card messages */
export async function getFeatureBrief(projectKey: string, workItemId: string): Promise<{
  name: string;
  priority: string;
  prd: string;
  meegoUrl: string;
  /** Active workflow node names in Chinese (e.g. ['iOS 开发', 'Android 开发']). */
  activeNodesCn: string[];
  /** Overall workflow status name in Chinese (e.g. '待线内评审', '开发中', '已完成'). Empty when unknown. */
  overallStatusName: string;
}> {
  const meegoUrl = `https://meego.larkoffice.com/${projectKey}/story/detail/${workItemId}`;
  const raw = await callMeegoMcp('get_workitem_brief', {
    url: meegoUrl,
    fields: ['wiki', 'priority'],
  });

  // Meego MCP now returns JSON; older deployments returned markdown. Try
  // JSON first, then fall back to markdown parsing.
  let name = '';
  let prd = '';
  let priorityRaw = '';
  let activeNodesCn: string[] = [];
  let overallStatusName = '';

  try {
    const briefJson = JSON.parse(raw) as {
      work_item_attribute?: {
        work_item_name?: string;
        work_item_status?: { key?: string; name?: string };
      };
      work_item_fields?: Array<{ key?: string; value?: unknown }>;
      work_item_current_node?: Array<{ name?: string }>;
    };
    name = briefJson.work_item_attribute?.work_item_name ?? '';
    overallStatusName = briefJson.work_item_attribute?.work_item_status?.name ?? '';
    const getField = (key: string): string => {
      const f = briefJson.work_item_fields?.find(fi => fi.key === key);
      if (!f || f.value === undefined || f.value === null) return '';
      if (typeof f.value === 'string') return f.value;
      if (typeof f.value === 'object' && 'value' in (f.value as Record<string, unknown>)) {
        return String((f.value as Record<string, unknown>).value ?? '');
      }
      return String(f.value);
    };
    prd = getField('wiki');
    priorityRaw = getField('priority');
    activeNodesCn = (briefJson.work_item_current_node ?? [])
      .map(n => n.name ?? '')
      .filter(Boolean);
  } catch {
    // Legacy markdown
    name = parseWorkItemField(raw, '工作项名称');
    prd = parseWorkItemField(raw, 'PRD');
    priorityRaw = parseWorkItemField(raw, '优先级');
    activeNodesCn = parseActiveNodes(raw).map(n => n.name).filter(Boolean);
  }

  if (!name) name = `Feature ${workItemId}`;
  // Normalize priority: JSON returns '0'..'3', markdown returns 'P0'..'P3'.
  if (/^[0-3]$/.test(priorityRaw)) priorityRaw = `P${priorityRaw}`;
  if (!priorityRaw) priorityRaw = 'P2';
  return { name, priority: priorityRaw, prd, meegoUrl, activeNodesCn, overallStatusName };
}

/** Structured version of getMyFeatures for internal use */
export async function listActiveFeatures(): Promise<Array<{ name: string; id: number; node: string; nodeCn: string; project: string }>> {
  const items: Array<{ name: string; id: number; node: string; nodeCn: string; project: string }> = [];
  let page = 1;

  while (true) {
    const raw = await callMeegoMcp('list_todo', { action: 'todo', page_num: page });
    const data = JSON.parse(raw) as {
      total: number;
      list: Array<{
        work_item_info: { work_item_id: number; work_item_name: string };
        project_key: string;
        node_info: { node_name: string };
      }>;
    };

    for (const item of data.list ?? []) {
      const nodeCn = item.node_info?.node_name ?? '';
      items.push({
        name: item.work_item_info.work_item_name,
        id: item.work_item_info.work_item_id,
        node: translateNode(nodeCn),
        nodeCn,
        project: item.project_key,
      });
    }
    if (items.length >= data.total) break;
    page++;
  }

  return items;
}
