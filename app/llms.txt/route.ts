/**
 * The rulebook for AI agents as plain text, at /llms.txt.
 *
 * An agent that can open a link can read it here. A person can paste it into
 * their agent's instructions. It is the same text as the MCP resource
 * "scrapy://rulebook", with Scrapy's address added.
 *
 * Anybody may read it, like the rest of the docs.
 */
import { originOf, rulebook } from '@/lib/docs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  // Plain text, so that every browser shows it and none offers to download it. The text itself is Markdown.
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
  return new Response(rulebook({ address: `${originOf(request)}/api/mcp` }), { headers });
}
