import { NextRequest, NextResponse } from 'next/server';
import { tools } from '@/lib/tools';

/**
 * Read-only listing of Junior's function-calling tools. Hamlet's Junior
 * Context tab fetches this via its own /api/junior-tools proxy and
 * renders it in the Tools section.
 *
 * Gated on CRON_SECRET (same value Hamlet stores as JUNIOR_CRON_SECRET)
 * to match Junior's existing internal-route convention. No mutation,
 * no secrets in the response.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  return NextResponse.json({ tools });
}
