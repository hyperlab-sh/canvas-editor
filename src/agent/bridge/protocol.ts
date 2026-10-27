// Local pairing protocol between the editor and an MCP server on the same
// machine. The editor polls `GET /next` (long-poll) and posts results back, so
// no WebSocket server dependency is needed and every hop is a simple request
// that can be origin-checked. Pure types + guards: the editor, the MCP server
// and their tests all decode the same way.
export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_DEFAULT_PORT = 43119;
/** Long-poll window; a parked request means "the editor is alive". */
export const BRIDGE_POLL_SECONDS = 25;
/** No poll for this long → the editor is gone. */
export const BRIDGE_IDLE_MS = 40_000;

export interface BridgePageSummary {
  readonly pageId: string;
  readonly name: string;
  readonly nodes: number;
  readonly connectors: number;
}

export interface BridgeClientInfo {
  readonly documentId: string;
  readonly name: string;
  readonly revision: number;
  readonly pageId: string;
  readonly pages: readonly BridgePageSummary[];
  readonly app: string;
}

export interface BridgeRequest {
  readonly id: string;
  readonly op: string;
  readonly input: unknown;
  readonly pageId?: string;
  /** The agent's MCP clientInfo.name ("claude-code"), so the editor can say who is drawing. */
  readonly client?: string;
}

export type BridgeResult =
  | { readonly id: string; readonly ok: true; readonly output: unknown }
  | { readonly id: string; readonly ok: false; readonly error: string };

export interface BridgeHealth {
  readonly ok: true;
  readonly protocol: number;
  readonly name: string;
  readonly version: string;
  readonly connected: boolean;
  readonly documentId: string | null;
  readonly documentName: string | null;
  readonly pageId: string | null;
  readonly pages: readonly BridgePageSummary[];
  readonly lastSeenMs: number | null;
}

/**
 * A comment a person typed in the editor, pushed to the agent's session (`POST /event`, live comments only).
 * Delivered to the session that owns the bridge port; best effort, never acknowledged.
 */
export interface BridgeThreadEvent {
  readonly type: 'thread';
  readonly documentId: string;
  readonly pageId: string;
  readonly threadId: string;
  readonly commentId: string;
  /** The node the thread is pinned to; null for a pin on the page. */
  readonly nodeId: string | null;
  /** That node's label; null when unpinned, unlabelled or deleted. */
  readonly nodeLabel: string | null;
  readonly kind: 'new_thread' | 'reply';
  /** Display name of the person. */
  readonly author: string;
  readonly body: string;
}

export const bridgeTokenHeader = 'x-openflowkit-token';

/** Browsers only: a present Origin must be the app or a local dev server. */
export function isAllowedBridgeOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
      || hostname === 'app.openflowkit.com';
  } catch {
    return false;
  }
}

export interface BridgeUrls {
  readonly base: string;
  readonly health: string;
  readonly hello: string;
  readonly next: string;
  readonly result: string;
  readonly event: string;
}

export function bridgeUrls(port: number, host = '127.0.0.1'): BridgeUrls {
  const base = `http://${host}:${port}`;
  return { base, health: `${base}/health`, hello: `${base}/hello`, next: `${base}/next`, result: `${base}/result`, event: `${base}/event` };
}

const isPageSummary = (value: unknown): value is BridgePageSummary => {
  const page = value as Record<string, unknown> | null;
  return !!page && typeof page.pageId === 'string' && typeof page.name === 'string'
    && typeof page.nodes === 'number' && typeof page.connectors === 'number';
};

/** A hello's document summary, whole: anything less would pair a phantom editor. */
export function isBridgeClientInfo(value: unknown): value is BridgeClientInfo {
  const info = value as Record<string, unknown> | null;
  return !!info && typeof info.documentId === 'string' && typeof info.name === 'string'
    && typeof info.revision === 'number' && typeof info.pageId === 'string' && typeof info.app === 'string'
    && Array.isArray(info.pages) && info.pages.every(isPageSummary);
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.op === 'string' && 'input' in record;
}


const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';

export function isBridgeThreadEvent(value: unknown): value is BridgeThreadEvent {
  const event = value as Record<string, unknown> | null;
  return !!event && event.type === 'thread'
    && ['documentId', 'pageId', 'threadId', 'commentId', 'author', 'body'].every((key) => typeof event[key] === 'string')
    && nullableString(event.nodeId) && nullableString(event.nodeLabel)
    && (event.kind === 'new_thread' || event.kind === 'reply');
}
