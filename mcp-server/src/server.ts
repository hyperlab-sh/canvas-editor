import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clientHasChannel, registerViewer } from './lib/card.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './lib/version.js';
import { CONNECT_URL, LiveBridge } from './lib/bridge.js';
import { DocumentStore } from './lib/documentStore.js';
import type { ServiceClient } from './lib/serviceClient.js';
import { registerServiceTools } from './tools/serviceTools.js';
import { registerValidateDsl } from './tools/validateDsl.js';
import { registerAnalyzeCodebase } from './tools/analyzeCodebase.js';
import { registerListTemplates } from './tools/listTemplates.js';
import { registerGetTemplate } from './tools/getTemplate.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerArchitectureTools } from './tools/architecture.js';
import { registerDocumentTools, registerOpTools, type OpToolDeps } from './tools/ops.js';
import type { BridgeThreadEvent } from './lib/agent.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';

export interface ServerOptions extends Partial<OpToolDeps> {
  /** Bridge port; defaults to CANVAS_BRIDGE_PORT or 43119. */
  readonly port?: number;
  readonly log?: (message: string) => void;
}

export interface CreatedServer {
  readonly server: McpServer;
  readonly service?: ServiceClient;
  readonly bridge: LiveBridge;
  readonly store: DocumentStore;
}

/** What the model reads before any tool: how a drawing reaches the user. */
export const INSTRUCTIONS = [
  'Canvas draws diagrams from a small text DSL (get_syntax for the grammar, validate_openflow_dsl to check it).',
  'How a drawing reaches the user: when a Canvas editor tab is paired with this server (whoami says mode "live-editor"),'
    + ' create_diagram, update_diagram and the other drawing tools draw live on that canvas, where the user sees them at once.',
  `When no editor is paired, ask the user to open ${CONNECT_URL} and press Connect, then call the tool again.`
    + ' Or use file mode: openflow_create (or openflow_open with a .openflow.json path), draw, then openflow_save;'
    + ' a file-mode drawing also returns an openUrl the user can open to see it.',
  'Several agent sessions can share one canvas: whoami shows bridge.shared when this server draws through another one.',
  'Threads: list_threads reads the conversations people pinned on the canvas (filter by threadId, or unanswered: true for the ones waiting on you); reply_to_thread adds a comment, resolve_thread closes one and start_thread opens one.',
  'If live comments are on, a new comment from the editor may arrive as <channel source="canvas" thread_id=… node_label=…>:'
    + ' reply with reply_to_thread using that thread_id. Without that, nothing is pushed; read the threads with list_threads when asked.',
  'Call whoami when unsure which mode you are in.',
].join('\n');

/**
 * Builds the MCP server and its live bridge. The bridge is started separately
 * (see index.ts) so tests can pair a fake editor without opening a socket.
 */
export function createServerWithDeps(options: ServerOptions = {}): CreatedServer {
  const store = options.store ?? new DocumentStore();
  const log = options.log ?? ((message: string) => console.error(message));
  const bridge = options.bridge ?? new LiveBridge({
    port: options.port ?? (Number.parseInt(process.env.CANVAS_BRIDGE_PORT ?? '', 10) || 43119),
    ...(process.env.CANVAS_BRIDGE_TOKEN ? { token: process.env.CANVAS_BRIDGE_TOKEN } : {}),
    log,
  });
  // `claude/channel` registers the push listener in Claude Code; a client without channels ignores it, so tools are unaffected.
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, {
    instructions: INSTRUCTIONS,
    capabilities: { experimental: { 'claude/channel': {} } },
  });
  // `?.`: tests hand in bridge doubles that only implement what they use.
  const forward = (event: BridgeThreadEvent): void => {
    // Absent values are left out: meta is string-to-string, and an empty attribute tells the model nothing.
    const meta = {
      document_id: event.documentId, page_id: event.pageId, thread_id: event.threadId, thread_number: String(event.threadNumber), comment_id: event.commentId,
      ...(event.nodeId ? { node_id: event.nodeId } : {}), ...(event.nodeLabel ? { node_label: event.nodeLabel } : {}),
      kind: event.kind, author: event.author,
    };
    // Dropped silently by a session that was not started with the channel flag; nothing to do about that here.
    void server.server.notification({ method: 'notifications/claude/channel', params: { content: event.body, meta } } as never).catch(() => undefined);
  };
  (bridge as Partial<LiveBridge>).onEvent?.(forward);
  // The editor disables Live comments when they would reach nobody: the bridge and the service tell it whether this session listens.
  const channel = (): boolean => clientHasChannel(server.server.getClientCapabilities());
  (bridge as Partial<LiveBridge>).channelFrom?.(channel);
  // Only the stdio entry point builds a service client (index.ts); a server made without one has no service tools.
  const service = options.service;
  service?.onEvent(forward);
  service?.channelFrom(channel);
  const deps: OpToolDeps = { store, bridge, ...(service ? { service } : {}) };

  registerValidateDsl(server);
  registerAnalyzeCodebase(server);
  registerListTemplates(server);
  registerGetTemplate(server);
  registerDiscoveryTools(server, bridge, service);
  registerArchitectureTools(server, store);
  registerDocumentTools(server, deps);
  registerOpTools(server, deps);
  if (service) registerServiceTools(server, service);
  registerResources(server);
  // Beside this module in src/ and in dist/ (scripts/build-dist.mjs copies it).
  registerViewer(server, () => readFile(new URL('./viewer/viewer.html', import.meta.url), 'utf8'));
  registerPrompts(server);

  return { server, service, bridge, store };
}

export function createServer(): McpServer {
  return createServerWithDeps().server;
}
