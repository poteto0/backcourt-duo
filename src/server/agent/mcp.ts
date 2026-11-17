// Streamable HTTP MCP endpoint for non-Claude backends (specs/sessions/agent-opencode.md).
// The same tool definitions as the Claude SDK server, exposed over HTTP so a separate `opencode`
// process can read and drive the shared review state.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ReviewStore } from '../store.js';
import { duoToolDefinitions, DUO_SERVER } from './tools.js';

export const DUO_MCP_PATH = '/mcp';
export const DUO_MCP_INSTRUCTIONS =
  'Tools that read and drive the shared backcourt-duo review state (diff, presence, plan, pending comments, change proposals, notes).';

/**
 * Handle one MCP Streamable HTTP request. Stateless (`sessionIdGenerator: undefined`) and JSON
 * responses; a fresh server per request keeps concurrent tool calls from sharing mutable state.
 */
export async function handleDuoMcpRequest(req: Request, store: ReviewStore): Promise<Response> {
  const server = new McpServer({ name: DUO_SERVER, version: '1.0.0' }, { instructions: DUO_MCP_INSTRUCTIONS });
  for (const d of duoToolDefinitions(store, (text) => store.system(text))) {
    server.registerTool(d.name, { description: d.description, inputSchema: d.shape }, (input) => d.run(input as Record<string, unknown>));
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}
