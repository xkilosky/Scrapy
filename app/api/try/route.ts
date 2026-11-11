/** Behind the "Try a tool" box. Runs a tool exactly as the MCP address does, and adds what happened. */
import { visitorOf } from '@/lib/limits';
import { runTool } from '@/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  let body: { tool?: unknown; args?: unknown };
  try {
    body = (await request.json()) as { tool?: unknown; args?: unknown };
  } catch {
    return Response.json({ ok: false, text: 'The request was not readable.' }, { status: 400 });
  }
  const run = await runTool(String(body.tool ?? ''), body.args ?? {}, visitorOf(request));
  return Response.json(run);
}
