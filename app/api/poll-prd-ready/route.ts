import { NextRequest, NextResponse } from 'next/server';
import { listActiveFeatures, getFeatureBrief } from '@/lib/meego';
import { sendPrdReadyCard } from '@/lib/lark';
import { recordEventOnce } from '@/lib/store';

export const maxDuration = 60;

/** Active node + overall status that mean "currently at Line Review". */
const LINE_REVIEW_NODE = '产品线内初评';
const LINE_REVIEW_STATUS = '待线内评审';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // ?dryRun=true marks all Line-Review features as "already sent" without
  // actually sending cards. Useful for initial backfill so existing features
  // don't trigger a flood of cards on the first real run.
  const dryRun = req.nextUrl.searchParams.get('dryRun') === 'true';

  try {
    const features = await listActiveFeatures();
    let sent = 0;
    const sentIds: string[] = [];

    for (const f of features) {
      // Hard guardrail: the feature's active node must be the Line Review
      // node. Anything later (RD Allocation, PRD Walkthrough, Development,
      // …) does NOT fire — the card may trigger compliance review and we
      // never want it sent retroactively for features past Line Review.
      if (f.nodeCn !== LINE_REVIEW_NODE) continue;

      // Belt-and-suspenders: re-confirm via the brief's overall status,
      // since a feature can have multiple active nodes simultaneously.
      let brief: Awaited<ReturnType<typeof getFeatureBrief>>;
      try {
        brief = await getFeatureBrief(f.project, String(f.id));
      } catch (e) {
        console.error(`[poll] brief fetch failed for ${f.name} (${f.id}):`, e);
        continue;
      }
      if (brief.overallStatusName !== LINE_REVIEW_STATUS) {
        console.log(`[poll] PRD Ready SKIPPED for "${f.name}" — overallStatus="${brief.overallStatusName}" (only fires when Line Review)`);
        continue;
      }

      // Skip if already sent (persistent dedup via KV)
      const dedupKey = `prd-ready:${f.project}:${f.id}`;
      const isNew = await recordEventOnce(dedupKey);
      if (!isNew) continue;

      if (dryRun) {
        sentIds.push(`${f.name} (${f.id}) [marked]`);
        continue;
      }

      try {
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
