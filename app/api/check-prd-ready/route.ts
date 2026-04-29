import { NextRequest, NextResponse } from 'next/server';
import { getFeatureBrief } from '@/lib/meego';
import { sendPrdReadyCard } from '@/lib/lark';
import { recordEventOnce } from '@/lib/store';

export const maxDuration = 30;

/** The single Meego overall status that triggers the PRD-Ready card. */
const LINE_REVIEW_STATUS = '待线内评审';

/**
 * POST /api/check-prd-ready
 *
 * Body: { project: string, id: string }
 * Auth: Bearer CRON_SECRET (shared with the nightly poll)
 *
 * Single-feature variant of /api/poll-prd-ready. Strict guardrail: only
 * fires when the feature's CURRENT overall status is 待线内评审 (Line
 * Review). The card may trigger compliance review downstream, so we
 * never fire for features already past Line Review (e.g. RD Allocation,
 * Development, Done) — even on first encounter.
 *
 * Persistent dedup via GCS so calling this repeatedly is safe.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { project, id } = await req.json() as { project?: string; id?: string };
  if (!project || !id) {
    return NextResponse.json({ error: 'project and id are required' }, { status: 400 });
  }

  try {
    const brief = await getFeatureBrief(project, id);
    if (brief.overallStatusName !== LINE_REVIEW_STATUS) {
      return NextResponse.json({
        ok: true,
        sent: false,
        reason: `current status "${brief.overallStatusName || '(unknown)'}" is not Line Review`,
        overallStatusName: brief.overallStatusName,
      });
    }

    const dedupKey = `prd-ready:${project}:${id}`;
    const isNew = await recordEventOnce(dedupKey);
    if (!isNew) {
      return NextResponse.json({ ok: true, sent: false, reason: 'already sent before' });
    }

    await sendPrdReadyCard({
      featureName: brief.name,
      prdUrl: brief.prd,
      priority: brief.priority,
      meegoUrl: brief.meegoUrl,
    });
    console.log(`[check-prd-ready] sent for ${brief.name} (${id})`);
    return NextResponse.json({ ok: true, sent: true });
  } catch (err) {
    console.error('[check-prd-ready] error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
