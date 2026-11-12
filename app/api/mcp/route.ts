/**
 * The MCP address. An AI agent connects here and gets Scrapy's tools.
 */
import { createMcpHandler } from 'mcp-handler';
import { closedMcpResponse, isOpen } from '@/lib/access';
import { VERSION } from '@/lib/config';
import { originOf, rulebook } from '@/lib/docs';
import { visitorOf } from '@/lib/limits';
import { RULEBOOK_URI, runTool, SERVER_INSTRUCTIONS, TOOLS, type ToolDef } from '@/lib/tools';
import { jsonSchemaOf } from '@/lib/tools/describe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Args = Record<string, unknown>;

/**
 * A tool's parameters, as the MCP layer gets them.
 *
 * The list of parameters that agents see is the tool's own schema. The check
 * of what an agent then sends is left to runTool. Otherwise the MCP layer
 * would turn a wrong call away before Scrapy saw it: the agent would get that
 * layer's wording instead of Scrapy's, and the call would be missing from the
 * live feed.
 */
function advertised(tool: ToolDef) {
  const json = jsonSchemaOf(tool.schema);
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'scrapy',
      validate: (value: unknown) => ({ value: (value ?? {}) as Args }),
      jsonSchema: { input: () => json, output: () => json },
      types: undefined as { input: Args; output: Args } | undefined,
    },
  };
}

const handler = createMcpHandler(
  (server) => {
    for (const tool of TOOLS) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: advertised(tool),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async (args, ctx) => {
          const visitor = ctx.http?.req ? visitorOf(ctx.http.req) : 'unknown';
          const run = await runTool(tool.name, args, visitor, { from: 'agent' });
          return { content: [{ type: 'text' as const, text: run.text }], ...(run.ok ? {} : { isError: true }) };
        },
      );
    }

    // The whole rulebook, for agents that read resources. See lib/docs.ts.
    server.registerResource(
      'rulebook',
      RULEBOOK_URI,
      {
        title: 'Scrapy: the rulebook for AI agents',
        description: 'How to call each Scrapy tool: which tool to use, the exact parameters with examples, what the answers look like, and what to do when a tool cannot do the job.',
        mimeType: 'text/markdown',
      },
      async (uri, ctx) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: rulebook(ctx.http?.req ? { address: `${originOf(ctx.http.req)}/api/mcp` } : {}) }],
      }),
    );
  },
  { serverInfo: { name: 'scrapy', version: VERSION }, instructions: SERVER_INSTRUCTIONS },
);

/** A closed Scrapy (see lib/access.ts) turns every agent away before any work is done. */
async function guarded(request: Request): Promise<Response> {
  if (!isOpen()) return closedMcpResponse();
  return handler(request);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
