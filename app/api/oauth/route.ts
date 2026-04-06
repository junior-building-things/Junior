const LARK_BASE_URL = process.env.LARK_BASE_URL ?? 'https://open.larkoffice.com';
const LARK_APP_ID = process.env.LARK_APP_ID!;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET!;

async function getTenantToken(): Promise<string> {
  const res = await fetch(`${LARK_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }),
  });
  const data = await res.json() as { tenant_access_token: string };
  return data.tenant_access_token;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');

  // No code — redirect to Lark OAuth
  if (!code) {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
    const redirectUri = `https://${host}/api/oauth`;
    const authUrl = `${LARK_BASE_URL}/open-apis/authen/v1/authorize?app_id=${LARK_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=auth`;
    return Response.redirect(authUrl);
  }

  // Exchange code for tokens
  const tenantToken = await getTenantToken();
  const res = await fetch(`${LARK_BASE_URL}/open-apis/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tenantToken}`,
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
  });
  const data = await res.json() as {
    code: number;
    msg?: string;
    data?: {
      access_token?: string;
      refresh_token?: string;
      expire_in?: number;
      refresh_expires_in?: number;
      open_id?: string;
      name?: string;
    };
  };

  if (data.code !== 0) {
    return new Response(`OAuth error: ${data.msg ?? data.code}`, { status: 400 });
  }

  const d = data.data!;

  // Persist refresh token to KV so it survives instance restarts
  if (d.refresh_token && process.env.KV_REST_API_URL) {
    try {
      const { kv } = await import('@vercel/kv');
      await kv.set('lark:refresh_token', d.refresh_token);
    } catch { /* best effort */ }
  }

  const body = [
    `User: ${d.name} (${d.open_id})`,
    ``,
    `LARK_USER_TOKEN=${d.access_token}`,
    `LARK_REFRESH_TOKEN=${d.refresh_token}`,
    `LARK_USER_OPEN_ID=${d.open_id}`,
    ``,
    `Access token expires in: ${Math.round((d.expire_in ?? 0) / 3600)}h`,
    `Refresh token expires in: ${Math.round((d.refresh_expires_in ?? 0) / 86400)}d`,
    ``,
    `Set these as Cloud Run env vars.`,
  ].join('\n');

  return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
}
