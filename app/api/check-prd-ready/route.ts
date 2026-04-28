import { NextRequest, NextResponse } from 'next/server';
import { getFeatureBrief } from '@/lib/meego';
import { sendPrdReadyCard } from '@/lib/lark';
import { recordEventOnce } from '@/lib/store';

export const maxDuration = 30;

// Nodes that come AFTER "Requirements Prep" — if a feature is at any of these,
// the PRD is considered ready. (Mirrors POST_REQ_PREP_NODES in poll-prd-ready.)
const POST_REQ_PREP_NODES = new Set([
  '产品线内初评',
  '技术评估&排优',
  '需求详评',
  '需求评审',
  '技术方案设计',
  'iOS 开发',
  'UI&UX验收',
  'Server上线',
  'AB实验',
  'PM验收',
  'PM走查',
  '依赖判断',
  '合规评估',
]);

/**
 * POST /api/check-prd-ready
 *
 * Body: { project: string, id: string }
 * Auth: Bearer CRON_SECRET (shared with the nightly poll)
 *
 * Single-feature variant of /api/poll-prd-ready. If the feature has moved
 * past Requirements Prep AND no PRD-Ready card has been sent for it before,
 * sends the card to the compliance chat. Persistent dedup via GCS so calling
 * this repeatedly is safe.
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
    const isPastPrep = brief.activeNodesCn.some(n => POST_REQ_PREP_NODES.has(n));
    console.log(`[check-prd-ready] ${project}/${id}: activeNodesCn=${JSON.stringify(brief.activeNodesCn)} isPastPrep=${isPastPrep}`);

    if (!isPastPrep) {
      return NextResponse.json({ ok: true, sent: false, reason: 'not past Requirements Prep', activeNodesCn: brief.activeNodesCn });
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
