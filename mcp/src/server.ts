import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import {
  McpServer,
  type CallToolResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { buildDesignFile } from '../../src/designFile';
import { ShareLinkTooLargeError, buildShareUrl, decodeTopology } from '../../src/share';
import { fetchStored, hasStoredLink } from '../../src/share/store';
import { buildTopology } from './design';
import { DEFAULT_RUN, describeRun, runDesign } from './run';
// Build outputs, inlined by the bundler so the published server is one
// file with nothing to find on disk. tsc cannot type a text import.
// @ts-expect-error -- imported as text
import readme from '../dist/readme.md' with { type: 'text' };
// @ts-expect-error -- imported as text
import widgetHtml from '../dist/widget.html' with { type: 'text' };

const APP_URL = 'https://breakscale.tech/';
const RESOURCE_URI = 'ui://breakscale/view.html';

/** Loose on purpose: `buildTopology` gives better errors than a schema can. */
const node = z.looseObject({
  id: z.string(),
  kind: z.string().describe('Component kind, for example service, db, cache, lb'),
  label: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  config: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
});

const edge = z.looseObject({
  from: z.string(),
  to: z.string(),
  weight: z.number().optional(),
  control: z.boolean().optional(),
});

/*
 * Both shapes a design arrives in.
 *
 * The plain one is what a caller writes by hand. The wrapped one is an
 * exported `.breakscale` file, which carries the design under `topology`
 * beside an app name and a version, and which read_me says is accepted as
 * is. `buildTopology` has always unwrapped it; the schema was what turned
 * it away, so handing back an export and passing it straight in failed on
 * `nodes: expected array` before any of that ran.
 *
 * `nodes` is optional here rather than required in either branch, because
 * the schema's job is only to get the request through to the validator.
 * A design with no nodes is then refused by `buildTopology`, which says
 * which node or edge is wrong instead of naming a JSON path.
 */
const design = {
  name: z.string().optional().describe('A short name for the design'),
  nodes: z.array(node).optional(),
  edges: z.array(edge).optional(),
  annotations: z.array(z.unknown()).optional(),
  faults: z.array(z.unknown()).optional(),
  seed: z.unknown().optional(),
  topology: z
    .looseObject({
      nodes: z.array(node).optional(),
      edges: z.array(edge).optional(),
      annotations: z.array(z.unknown()).optional(),
      faults: z.array(z.unknown()).optional(),
      seed: z.unknown().optional(),
    })
    .optional()
    .describe('An exported .breakscale file can be passed in as it is'),
};

function text(body: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError } : {}) };
}

function rejected(errors: string[]): CallToolResult {
  return text(
    'The design was not accepted:\n' +
      errors.map((e) => `- ${e}`).join('\n') +
      '\nFix these and call again. read_me has the format.',
    true,
  );
}

export function createServer({ budgetMs }: { budgetMs?: number } = {}): McpServer {
  const server = new McpServer({ name: 'Breakscale', version: '0.1.0' });
  const runOptions = { ...DEFAULT_RUN, budgetMs: budgetMs ?? DEFAULT_RUN.budgetMs };

  server.registerTool(
    'read_me',
    {
      title: 'Read the design format',
      description:
        'Returns the Breakscale design format that create_view takes: every component, its settings and defaults, how requests route, and how real code maps onto components.',
      annotations: { title: 'Read the design format', readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => text(readme as string),
  );

  registerAppTool(
    server,
    'create_view',
    {
      title: 'Show design',
      description:
        'Shows a system design on a live Breakscale canvas the user can run, load and edit, and simulates it, returning measured latency, throughput and failure numbers and a breakscale.tech link to the design. Takes a design in the format read_me describes.',
      inputSchema: z.object(design),
      annotations: { title: 'Show design', readOnlyHint: true },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (args): Promise<CallToolResult> => {
      const built = buildTopology(args);
      if (!built.ok) return rejected(built.errors);
      const { topology } = built;

      const run = runDesign(topology, runOptions);
      const lines = [describeRun(topology, run, runOptions)];
      try {
        // Said as what the link does, not as an instruction to pass it on:
        // the connector directory rejects text that tells the model how to
        // behave, and in testing models relayed the link either way.
        lines.push(
          '',
          `Link to the design, which opens it on breakscale.tech: ${await buildShareUrl(topology, APP_URL)}`,
        );
      } catch (err) {
        if (!(err instanceof ShareLinkTooLargeError)) throw err;
        lines.push(
          '',
          'The design is too large for a link; use export_design to save it as a file.',
        );
      }
      lines.push(
        '',
        'A changed design can be shown by passing the whole updated design to create_view; keeping the node ids keeps the layout stable. ' +
          'Edits the user makes on the canvas are reported back as context.',
      );
      // Text only. The view rebuilds the topology from the tool's input
      // rather than reading it from here: some hosts (Claude Code) show the
      // model structuredContent INSTEAD of the text, which swapped these
      // numbers for a wall of config.
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'export_design',
    {
      title: 'Export a design file',
      description:
        'Returns a design as the text of a .breakscale file, which the Breakscale app and its VS Code extension open with Settings, Open a file. Takes the same input as create_view.',
      inputSchema: z.object(design),
      annotations: { title: 'Export a design file', readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      const built = buildTopology(args);
      if (!built.ok) return rejected(built.errors);
      return text(buildDesignFile(built.topology, built.name));
    },
  );

  server.registerTool(
    'open_design',
    {
      title: 'Open a share link',
      description:
        'Reads a Breakscale share link (a breakscale.tech URL) and returns the design in it, in the format create_view takes.',
      inputSchema: z.object({ link: z.string().describe('The whole share link') }),
      annotations: {
        title: 'Open a share link',
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ link }): Promise<CallToolResult> => {
      let url: URL;
      try {
        url = new URL(link);
      } catch {
        return text('That is not a URL.', true);
      }
      const result = hasStoredLink(url.search, url.hash)
        ? await fetchStored(url.search, url.hash)
        : await decodeTopology(url.hash);
      if (result.status === 'absent') {
        return text('That link does not carry a Breakscale design.', true);
      }
      if (result.status === 'invalid') return text(result.message, true);
      return text(JSON.stringify(result.topology));
    },
  );

  registerAppResource(
    server,
    'Breakscale view',
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml as string,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
  );

  return server;
}
