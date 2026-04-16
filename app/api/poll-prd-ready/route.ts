import { NextRequest, NextResponse } from 'next/server';
import { listActiveFeatures, getFeatureBrief } from '@/lib/meego';
import { sendPrdReadyCard } from '@/lib/lark';
import { recordEventOnce } from '@/lib/store';

export const maxDuration = 60;

// Nodes that come AFTER "Requirements Prep" — if a feature is at any of these,
// the PRD is considered ready
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

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // ?dryRun=true marks all past-Requirements-Prep features as "already sent"
  // without actually sending cards. Useful for initial backfill so existing
  // features don't trigger a flood of cards on the first real run.
  const dryRun = req.nextUrl.searchParams.get('dryRun') === 'true';

  try {
    const features = await listActiveFeatures();
    let sent = 0;
    const sentIds: string[] = [];

    for (const f of features) {
      // Skip if not past Requirements Prep
      if (!POST_REQ_PREP_NODES.has(f.nodeCn)) continue;

      // Skip if already sent (persistent dedup via KV)
      const dedupKey = `prd-ready:${f.project}:${f.id}`;
      const isNew = await recordEventOnce(dedupKey);
      if (!isNew) continue;

      if (dryRun) {
        sentIds.push(`${f.name} (${f.id}) [marked]`);
        continue;
      }

      try {
        const brief = await getFeatureBrief(f.project, String(f.id));
        await sendPrdReadyCard({
          featureName: brief.name,
          prdUrl: brief.prd,
          priority: brief.priority,
          meegoUrl: brief.meegoUrl,
        });
        sent++;
        sentIds.push(`${f.name} (${f.id})`);
        console.log(`[poll] PRD Ready card sent for ${f.name} (${f.id})`);
      } catch (e) {
        console.error(`[poll] Failed for ${f.name} (${f.id}):`, e);
      }
    }

    return NextResponse.json({ dryRun, checked: features.length, sent, sentIds });
  } catch (err) {
    console.error('[poll] Error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
