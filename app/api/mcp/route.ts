/**
 * The MCP address. An AI agent connects here and gets Scrapy's tools.
 */
import { createMcpHandler } from 'mcp-handler';
import { closedMcpResponse, isOpen } from '@/lib/access';
import { VERSION } from '@/lib/config';
import { visitorOf } from '@/lib/limits';
import { runTool, SERVER_INSTRUCTIONS, TOOLS } from '@/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    for (const tool of TOOLS) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.schema,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async (args, ctx) => {
          const visitor = ctx.http?.req ? visitorOf(ctx.http.req) : 'unknown';
          const run = await runTool(tool.name, args, visitor);
          return { content: [{ type: 'text' as const, text: run.text }], ...(run.ok ? {} : { isError: true }) };
        },
      );
    }
  },
  { serverInfo: { name: 'scrapy', version: VERSION }, instructions: SERVER_INSTRUCTIONS },
);

/** A closed Scrapy (see lib/access.ts) turns every agent away before any work is done. */
async function guarded(request: Request): Promise<Response> {
  if (!isOpen()) return closedMcpResponse();
  return handler(request);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
