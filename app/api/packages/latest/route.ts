import { NextResponse } from 'next/server';

const BUCKET = process.env.GCS_DEDUP_BUCKET ?? 'junior-kv-tiktok-im';
const OBJECT = 'packages/latest.json';

export async function GET() {
  try {
    const { Storage } = await import('@google-cloud/storage');
    const file = new Storage().bucket(BUCKET).file(OBJECT);
    const [exists] = await file.exists();
    if (!exists) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const [contents] = await file.download();
    const data = JSON.parse(contents.toString());
    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, max-age=60, s-maxage=60',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    console.error('[packages/latest] Error:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
