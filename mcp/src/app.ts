import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import cors from 'cors';
import type { Express, Request, Response } from 'express';
import type { BreakLimits } from './breakIt';
import { createServer } from './server';

export interface HttpOptions {
  /** The address the server binds to; decides whether localhost checks apply. */
  host: string;
  /** Hostnames to answer to, replacing the SDK's localhost-only default. */
  allowedHosts?: string[];
  /** Wall-clock ceiling for one design's simulation, in ms. */
  budgetMs?: number;
  /** How much one break_it call may search. */
  breakLimits?: BreakLimits;
}

/**
 * Streamable HTTP on /mcp, stateless: a fresh server per request, which is
 * what lets a host run as many copies as it likes. Shared by the local
 * `node dist/index.js` and the hosted function, so both serve the same
 * thing. /api/mcp answers too, since that is the path a Vercel rewrite
 * lands on.
 */
export function createHttpApp({
  host,
  allowedHosts,
  budgetMs,
  breakLimits,
}: HttpOptions): Express {
  const app = createMcpExpressApp({ host, ...(allowedHosts ? { allowedHosts } : {}) });
  app.use(cors());

  app.all(['/mcp', '/api/mcp'], async (req: Request, res: Response) => {
    const server = createServer({ budgetMs, ...(breakLimits ? { breakLimits } : {}) });
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  return app;
}
