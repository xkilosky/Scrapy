/**
 * Behind the Docs pages: everything they show, read from the running Scrapy.
 * The tools' parameters, the rulebook for agents, the limits, and the order
 * in which the helpers are asked. Contacts nobody.
 *
 * Anybody may read the docs, also where the tools are for the owner alone.
 */
import { docsPayload } from '@/lib/docs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json(docsPayload(), { headers: { 'Cache-Control': 'no-store' } });
}
