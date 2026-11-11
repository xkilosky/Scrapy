/** Behind the "Run checks" button. */
import { runChecks, type CheckReport } from '@/lib/check';
import { ScrapyError } from '@/lib/errors';
import { getLimiter, visitorOf } from '@/lib/limits';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

/** The checks use up a little of every helper's free allowance, so a result is reused for two minutes. */
const REUSE_SEC = 120;

export async function POST(request: Request): Promise<Response> {
  const store = getStore();
  const last = await store.get<CheckReport>('check:last');
  if (last) return Response.json({ ...last, reused: true });
  try {
    await getLimiter().check(visitorOf(request));
  } catch (err) {
    if (err instanceof ScrapyError) return Response.json({ error: err.message }, { status: 429 });
    throw err;
  }
  const report = await runChecks();
  await store.set('check:last', report, REUSE_SEC);
  return Response.json({ ...report, reused: false });
}
