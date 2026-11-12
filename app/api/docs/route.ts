/**
 * Behind the Docs pages: everything they show, read from the running Scrapy.
 * The tools' parameters, the rulebook for agents, the limits, and the order
 * in which the helpers are asked. Contacts nobody.
 */
import { closedResponse, isOpen } from '@/lib/access';
import { docsPayload } from '@/lib/docs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  if (!isOpen()) return closedResponse();
  return Response.json(docsPayload(), { headers: { 'Cache-Control': 'no-store' } });
}
