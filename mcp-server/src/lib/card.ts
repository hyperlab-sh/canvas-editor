// The diagram card: what an MCP Apps host (Claude, ChatGPT, VS Code) draws inline next to a tool result.
// Local and remote servers hand the viewer (src/viewer/viewer.html) the same shape, so it looks the same everywhere.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { openUrl } from './openLink.js';
import { toolError } from './errors.js';
import { previewSvg, type LayoutPortLike } from '../remote/render.js';

export const VIEWER_URI = 'ui://openflowkit/viewer.html';
export const VIEWER_MIME = 'text/html;profile=mcp-app';
// MCP Apps: `_meta.ui.resourceUri` (the flat "ui/resourceUri" key is deprecated).
// ponytail: no `openai/outputTemplate` — neither the MCP Apps spec nor the Apps SDK docs ask for it; add it if ChatGPT fails to render.
export const VIEWER_TOOL_META = { ui: { resourceUri: VIEWER_URI } };
// The viewer draws the SVG it is handed: no network, no external assets.
export const VIEWER_RESOURCE_META = { ui: { csp: { connectDomains: [], resourceDomains: [] } } };
/** The extension id a host puts in `capabilities.extensions` when it can show MCP Apps. */
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';

/** Over this the picture is not sent: hosts cap tool results, and an iframe chokes on a multi-megabyte data URL. */
export const MAX_CARD_SVG_BYTES = 1024 * 1024;

export interface CardInput {
  readonly title: string;
  readonly svg: string | null;
  readonly dsl: string;
  readonly nodes: number;
  readonly connectors: number;
  readonly diagnostics: readonly { severity: string; line: number; message: string }[];
  readonly losses: readonly string[];
  readonly appOrigin: string;
}

export interface Card {
  readonly title: string;
  readonly svg?: string;
  /** Set instead of `svg` when there is no picture to show; the viewer says it and keeps "Open in OpenFlowKit". */
  readonly noPreview?: string;
  readonly dsl: string;
  readonly openUrl: string | null;
  readonly nodes: number;
  readonly connectors: number;
  readonly diagnostics: CardInput['diagnostics'];
  readonly losses: readonly string[];
  /**
   * When and in what order the server drew it: the viewer greys out every card older than the newest one in the
   * conversation (Claude's "instance supersession" pattern). Server-minted, so a reloaded transcript keeps the order.
   */
  readonly createdAt: number;
  readonly seq: number;
}

let cardSeq = 0;

export function diagramCard({ svg, appOrigin, losses, ...rest }: CardInput): Card {
  const link = openUrl(rest.dsl, appOrigin);
  const allLosses = link ? losses : [...losses, 'too large to open by link; download the file instead'];
  const bytes = svg === null ? 0 : Buffer.byteLength(svg, 'utf8');
  const picture = svg !== null && bytes <= MAX_CARD_SVG_BYTES
    ? { svg }
    : { noPreview: svg === null ? 'No preview is available for this diagram.' : `The picture is ${Math.round(bytes / 1024)} KB, too large to show here.` };
  return { ...rest, ...picture, openUrl: link, losses: allLosses, createdAt: Date.now(), seq: ++cardSeq };
}

/**
 * True when the connected client said, at initialize, that it can show MCP Apps. Anything else gets text only:
 * some clients pass `structuredContent` to the model, and a megabyte of SVG there is wasted context.
 */
export function clientShowsApps(capabilities: { extensions?: Record<string, unknown> } | undefined): boolean {
  const ui = capabilities?.extensions?.[MCP_APPS_EXTENSION] as { mimeTypes?: unknown } | undefined;
  // A host that names its mime types must name ours; one that names none is taken at its word.
  return Boolean(ui) && typeof ui === 'object' && (!Array.isArray(ui.mimeTypes) || ui.mimeTypes.includes(VIEWER_MIME));
}

/**
 * True when the client declared `claude/channel` at initialize, or the operator set OPENFLOWKIT_CHANNEL=1 for a
 * session started with channels (D15): a client that listens for thread events does not always say so.
 */
export function clientHasChannel(capabilities: { experimental?: Record<string, unknown> } | undefined): boolean {
  return capabilities?.experimental?.['claude/channel'] !== undefined || process.env.OPENFLOWKIT_CHANNEL === '1';
}

export const PREVIEW_TOOL = 'preview_diagram';
/** Hosts keep an app-only tool out of the model's tool list and let only the card call it (MCP Apps `visibility`). */
export const PREVIEW_TOOL_META = { ui: { resourceUri: VIEWER_URI, visibility: ['app'] } };
const MAX_PREVIEW_SOURCE_BYTES = 100 * 1024;

export interface ViewerOptions {
  /** The preview's layout engine; default the headless ELK. Tests inject one. */
  readonly layout?: LayoutPortLike;
  readonly deadlineMs?: number;
}

/**
 * The `ui://` page hosts fetch to draw the card, and the app-only tool it calls to draw the diagram while the model is
 * still writing it. The local and remote servers serve the same file and the same tool.
 */
export function registerViewer(server: McpServer, viewerHtml: () => string | Promise<string>, options: ViewerOptions = {}): void {
  server.registerResource('viewer', VIEWER_URI, { title: 'Diagram viewer', mimeType: VIEWER_MIME, _meta: VIEWER_RESOURCE_META }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: VIEWER_MIME, text: await viewerHtml(), _meta: VIEWER_RESOURCE_META }],
  }));
  const preview = server.registerTool(PREVIEW_TOOL, {
    title: 'Preview a diagram being written',
    description: 'Used by the diagram card to draw while a diagram is being written. Not for the model: call render_diagram or create_diagram.',
    inputSchema: {
      source: z.string().min(1).max(MAX_PREVIEW_SOURCE_BYTES),
      theme: z.enum(['light', 'dark']).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: PREVIEW_TOOL_META,
  }, async ({ source, theme }): Promise<CallToolResult> => {
    try {
      if (Buffer.byteLength(source, 'utf8') > MAX_PREVIEW_SOURCE_BYTES) return toolError('source is over 100 KB');
      const drawn = await previewSvg(source, theme ?? 'light', options);
      if ('refused' in drawn) return toolError(drawn.refused);
      if (Buffer.byteLength(drawn.svg, 'utf8') > MAX_CARD_SVG_BYTES) return toolError('The preview is too large to show.');
      return { content: [{ type: 'text', text: `${drawn.nodes} nodes, ${drawn.connectors} connectors` }], structuredContent: { ...drawn } };
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });
  // A host without MCP Apps would put this tool in front of the model, so a server that met its client (local, stdio)
  // takes it away from one that did not say it shows apps. A stateless remote server never meets its client and keeps it.
  const previous = server.server.oninitialized;
  server.server.oninitialized = () => {
    previous?.();
    if (!clientShowsApps(server.server.getClientCapabilities())) preview.disable();
  };
}
