import { getTenantToken, saveTokensToSecret } from '@/lib/lark';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');

  // No code — redirect to Lark OAuth
  if (!code) {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
    const redirectUri = `https://${host}/api/oauth`;
    const LARK_BASE_URL = process.env.LARK_BASE_URL ?? 'https://open.larkoffice.com';
    const LARK_APP_ID = process.env.LARK_APP_ID!;
    const authUrl = `${LARK_BASE_URL}/open-apis/authen/v1/authorize?app_id=${LARK_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=auth`;
    return Response.redirect(authUrl);
  }

  // Exchange code for tokens
  const LARK_BASE_URL = process.env.LARK_BASE_URL ?? 'https://open.larkoffice.com';
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
      open_id?: string;
      name?: string;
    };
  };

  if (data.code !== 0) {
    return new Response(`OAuth error: ${data.msg ?? data.code}`, { status: 400 });
  }

  const d = data.data!;

  // Persist tokens to Secret Manager so they survive instance restarts
  if (d.access_token && d.refresh_token) {
    await saveTokensToSecret({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + (d.expire_in ?? 7200) * 1000,
    });
  }

  // Only show the user's name — never display tokens in the browser
  const body = [
    `Authenticated as: ${d.name ?? 'unknown'}`,
    `Open ID: ${d.open_id ?? 'unknown'}`,
    ``,
    `Tokens saved to Secret Manager.`,
    `Set LARK_USER_OPEN_ID=${d.open_id} as a Cloud Run env var if not already configured.`,
  ].join('\n');

  return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
}
