import { NextRequest, NextResponse } from 'next/server';

const BUCKET = process.env.GCS_DEDUP_BUCKET ?? 'junior-kv-tiktok-im';
const OBJECT = 'packages/latest.json';

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    const payload = await req.json();
    const { Storage } = await import('@google-cloud/storage');
    const file = new Storage().bucket(BUCKET).file(OBJECT);
    await file.save(JSON.stringify(payload), { contentType: 'application/json' });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[packages/update] Error:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
