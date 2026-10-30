// Live bridge server: pairs this MCP server with a local editor window.
//
// Transport is HTTP long-polling over stdlib `http` (no WebSocket dependency):
// the editor parks on `GET /next`, the server hands it one op request at a
// time, and the editor posts the result back. A parked request doubles as the
// liveness signal. Every request is origin-checked and optionally token-gated,
// so a random web page cannot drive the editor.
//
// One port, many agents: each agent session starts its own MCP server, and only
// the first binds the port. A later one that finds a Canvas server there
// becomes its guest and sends its ops through `POST /call` (local servers only),
// so every agent draws on the one paired canvas. When the holder exits, the
// guest takes the port and the editor re-pairs with it.
//
// Tabs: the app names its tab (`?tab=`) on /hello and /next. The tab that said
// hello last owns the polls; any other tab's poll gets 409, so two tabs can
// never split ops. An app without tab ids behaves as before.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  BRIDGE_IDLE_MS, BRIDGE_POLL_SECONDS, BRIDGE_PROTOCOL_VERSION, bridgeTokenHeader,
  isAllowedBridgeOrigin, isBridgeClientInfo, isBridgeThreadEvent,
  type BridgeClientInfo, type BridgeThreadEvent, type BridgeHealth, type BridgeRequest,
} from './agent.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './version.js';
import { DEFAULT_APP_ORIGIN } from './openLink.js';
import { isAllowedBridgeHost, isFromBrowser } from './bridgeGuards.js';

/** The app's page that opens Connect agent: what a user without a paired editor is sent to. */
export const CONNECT_URL = `${DEFAULT_APP_ORIGIN}/#/connect`;
/** The one line every tool says when it needed an editor and none is paired. */
export const NOT_PAIRED = `No editor is paired. Ask the user to open ${CONNECT_URL} and press Connect, then call again; or use file mode (openflow_create, or openflow_open with a .openflow.json path).`;

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const EDITOR_GONE = 'The editor tab was closed or reloaded. Reopen it and press Connect.';
/** A refused token this recent means an editor is still trying (it retries every 1.5 s). */
const REFUSED_FRESH_MS = 10_000;
const TAB_TAKEN = 'Another tab took over the agent connection. Press Connect in this tab to take it back.';
/** The shape of `POST /call`, served in /health as `share`. A guest refuses a holder on another number. */
const SHARE_PROTOCOL = 1;
/** A guest that called within this window is listed in the holder's status. */
const GUEST_WINDOW_MS = 10 * 60_000;

export interface BridgeStatus {
  readonly port: number;
  readonly state: 'off' | 'listening' | 'paired' | 'port-in-use' | 'shared';
  /** holder: other agent sessions draw through this server; guest: this server draws through the holder. */
  readonly shared?: { readonly side: 'holder'; readonly guests: readonly string[] }
    | { readonly side: 'guest'; readonly holder: string; readonly editorPaired: boolean };
}

interface PendingCall {
  readonly resolve: (output: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface LiveBridgeOptions {
  readonly port: number;
  /** Required on every request when set (CANVAS_BRIDGE_TOKEN). */
  readonly token?: string;
  readonly callTimeoutMs?: number;
  /** Least gap between attempts to take a port another process held (default 3 s). */
  readonly retryMs?: number;
  readonly log?: (message: string) => void;
}

export class LiveBridge {
  private server: Server | null = null;
  private client: (BridgeClientInfo & { readonly origin: string | null }) | null = null;
  private lastSeenAt: number | null = null;
  /** The paired editor dropped its poll without saying goodbye; calls say so until it pairs again. */
  private gone = false;
  private portInUse = false;
  private lastListenAt = 0;
  /** When an editor last knocked with the wrong token; the editor then shows the error, and so must whoami. */
  private refusedAt: number | null = null;
  private parked: ServerResponse | null = null;
  /** The tab that said hello last, and the tab whose poll is parked; null for an app without tab ids. */
  private tab: string | null = null;
  private parkedTab: string | null = null;
  /** Guest mode: the holder's last /health. Set only while another Canvas server owns the port and can share. */
  private holder: BridgeHealth | null = null;
  /** Why the port's owner cannot be shared (another program, a refused token, another protocol). */
  private holderProblem: string | null = null;
  /** Holder mode: agents (MCP clientInfo.name) that drew through /call, and when. */
  private readonly guests = new Map<string, number>();
  private readonly queue: BridgeRequest[] = [];
  private readonly pending = new Map<string, PendingCall>();
  private readonly options: LiveBridgeOptions;
  private eventSink: ((event: BridgeThreadEvent) => void) | null = null;
  /** Whether the session can receive what `POST /event` brings; read when the editor asks, since a client declares it only at initialize. */
  private channelSource: () => boolean = () => false;
  /** What the paired editor was last told about the channel, so a change since its hello reaches it on its next poll. */
  private toldChannel: boolean | null = null;

  constructor(options: LiveBridgeOptions) {
    this.options = options;
  }

  /** Where `POST /event` goes (the MCP server's channel notification). Only the process that owns the port ever hears one. */
  onEvent(sink: (event: BridgeThreadEvent) => void): void {
    this.eventSink = sink;
  }

  /** Tells the editor whether comments reach the session (the `channel` of `/hello`, `/health` and a `/next` notice). */
  channelFrom(source: () => boolean): void {
    this.channelSource = source;
  }

  get connected(): boolean {
    if (this.holder) return this.holder.connected;
    return this.client !== null && this.lastSeenAt !== null && Date.now() - this.lastSeenAt < BRIDGE_IDLE_MS;
  }

  /**
   * Starts listening and resolves with the bound port. When another Canvas server owns the port and
   * can share it, resolves too, as its guest (status().state 'shared'); otherwise rejects with EADDRINUSE.
   */
  async start(): Promise<number> {
    if (this.server) return this.boundPort;
    this.lastListenAt = Date.now();
    const server = createServer((request, response) => { void this.handle(request, response); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.port, '127.0.0.1', () => resolve());
      });
    } catch (error) {
      this.portInUse = (error as { code?: string }).code === 'EADDRINUSE';
      if (this.portInUse && await this.probeHolder() === 'shared') return this.options.port;
      throw error;
    }
    if (this.portInUse) this.options.log?.(`The server that held port ${this.options.port} exited; this one holds it now.`);
    this.portInUse = false;
    this.holder = null;
    this.holderProblem = null;
    this.server = server;
    return this.boundPort;
  }

  private get boundPort(): number {
    return (this.server?.address() as { port: number } | null)?.port ?? this.options.port;
  }

  /**
   * The port's holder may have exited since start(): listen again, at most once per `retryMs`; in between,
   * ask the holder what its editor shows (a guest's `connected`). Callers: whoami, server_info, ops.
   */
  async retryPort(): Promise<void> {
    if (!this.portInUse) return;
    if (Date.now() - this.lastListenAt >= (this.options.retryMs ?? 3000)) { await this.start().catch(() => undefined); return; }
    // Nothing answers on the port any more: it is free, so take it now rather than after the gap.
    if (await this.probeHolder() === 'gone') await this.start().catch(() => undefined);
  }

  /** What whoami reports: whether this process can pair at all, on which port, and who shares it. */
  status(): BridgeStatus {
    const port = this.boundPort;
    if (this.holder) {
      return { port, state: 'shared', shared: { side: 'guest', holder: `${this.holder.name} ${this.holder.version}`, editorPaired: this.holder.connected } };
    }
    const state = this.portInUse ? 'port-in-use' : !this.server ? 'off' : this.connected ? 'paired' : 'listening';
    for (const [name, at] of this.guests) if (Date.now() - at > GUEST_WINDOW_MS) this.guests.delete(name);
    return this.guests.size ? { port, state, shared: { side: 'holder', guests: [...this.guests.keys()] } } : { port, state };
  }

  /** Why this process has no editor, for a tool that needed one. */
  get unpairedReason(): string | null {
    if (this.portInUse && !this.holder) return this.holderProblem ?? `Another program already owns port ${this.options.port}; this one can only edit files (openflow_open).`;
    if (!this.connected && this.refusedAt !== null && Date.now() - this.refusedAt < REFUSED_FRESH_MS) {
      return 'An editor tried to pair and this server refused its token: the editor and this server hold different tokens. '
        + 'Ask the user to copy the MCP configuration from the editor\'s Connect agent panel again and restart this MCP client.';
    }
    return null;
  }

  async stop(): Promise<void> {
    for (const [, call] of this.pending) { clearTimeout(call.timer); call.reject(new Error('Bridge stopped.')); }
    this.pending.clear();
    if (this.parked) this.respond(this.parked, 204, null);
    this.parked = null;
    const server = this.server;
    this.server = null;
    this.client = null;
    this.holder = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  health(): BridgeHealth {
    // A guest reports the holder's editor under its own name.
    if (this.holder) return { ...this.holder, name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION, share: SHARE_PROTOCOL };
    return {
      ok: true,
      protocol: BRIDGE_PROTOCOL_VERSION,
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      connected: this.connected,
      channel: this.channelSource(),
      documentId: this.client?.documentId ?? null,
      documentName: this.client?.name ?? null,
      pageId: this.connected ? this.client?.pageId ?? null : null,
      pages: this.connected ? this.client?.pages ?? [] : [],
      lastSeenMs: this.lastSeenAt === null ? null : Date.now() - this.lastSeenAt,
      share: SHARE_PROTOCOL,
    };
  }

  /** How long an op may wait: a parked editor replies instantly. */
  private get callTimeoutMs(): number {
    return this.options.callTimeoutMs ?? (BRIDGE_POLL_SECONDS + 20) * 1000;
  }

  /** Sends one op to the paired editor (through the holder, as a guest) and waits for its result. `agent` names the MCP client. */
  async call(op: string, input: unknown, pageId?: string, agent?: string): Promise<unknown> {
    if (this.holder) return this.forward(op, input, pageId, agent);
    if (!this.connected) throw new Error(this.gone ? EDITOR_GONE : this.unpairedReason ?? NOT_PAIRED);
    const request: BridgeRequest = { id: randomUUID(), op, input, ...(pageId ? { pageId } : {}), ...(agent ? { client: agent } : {}) };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`The editor did not answer "${op}" in ${Math.round(this.callTimeoutMs / 1000)}s.`));
      }, this.callTimeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
    });
    this.queue.push(request);
    this.flush();
    return promise;
  }

  /** Guest: runs one op on the holder's editor through `POST /call`. */
  private async forward(op: string, input: unknown, pageId?: string, agent?: string): Promise<unknown> {
    const port = this.options.port;
    let reply: { status: number; body: unknown };
    try {
      reply = await this.local('POST', '/call', { op, input, ...(pageId ? { pageId } : {}), ...(agent ? { client: agent } : {}) }, this.callTimeoutMs + 5000);
    } catch (error) {
      // Slow is not gone: a holder busy with a big layout keeps the canvas; only a closed or reset socket hands the port over.
      if ((error as { code?: string }).code === 'ETIMEDOUT') {
        throw new Error(`The Canvas MCP server that holds the canvas did not answer "${op}" in time. Check the canvas (get_document) before repeating it.`);
      }
      // The holder exited: take the port now, so the editor re-pairs with this server.
      this.holder = null;
      await this.start().catch(() => undefined);
      throw new Error(this.server
        ? `The Canvas MCP server that held the canvas exited during "${op}"; this one holds port ${port} now and the editor re-pairs by itself within seconds. Check the canvas (get_document) before repeating "${op}".`
        : `The Canvas MCP server on port ${port} did not answer "${op}".`);
    }
    const body = reply.body as { ok?: boolean; output?: unknown; error?: string; health?: BridgeHealth } | null;
    if (body?.health && this.holder) this.holder = body.health;
    if (reply.status !== 200 || !body) throw new Error(body?.error ?? `The Canvas MCP server on port ${port} answered ${reply.status}.`);
    if (!body.ok) throw new Error(body.error ?? 'The editor reported an error.');
    return body.output;
  }

  /** Asks whoever owns the port who it is: 'shared' (a compatible Canvas server), 'refused' (anything else), or 'gone'. */
  private async probeHolder(): Promise<'shared' | 'refused' | 'gone'> {
    const port = this.options.port;
    const was = this.holder;
    const wasGuest = was !== null;
    const reply = await this.local('GET', '/health').catch((error: { code?: string }) => error);
    // A holder too busy to answer within the probe (a big layout in its process) is still the holder.
    if (!('status' in reply) && reply.code === 'ETIMEDOUT' && was) return 'shared';
    this.holder = null;
    if (!('status' in reply)) {
      // Something holds the port but did not answer in time: most likely a Canvas server busy with a layout, so say that
      // (the next whoami or tool call probes again) rather than "another program".
      this.holderProblem = reply.code === 'ETIMEDOUT'
        ? `The server holding port ${port} did not answer in time (a Canvas server busy with a big layout, most likely). Try again in a few seconds; until then this one can only edit files (openflow_open).`
        : null;
      return reply.code === 'ECONNREFUSED' ? 'gone' : 'refused';
    }
    const health = reply.body as Partial<BridgeHealth> | null;
    if (reply.status === 401) {
      this.holderProblem = `Another Canvas MCP server owns port ${port} and refused this server's token (the two hold different CANVAS_BRIDGE_TOKEN values), so this one can only edit files (openflow_open).`;
    } else if (reply.status !== 200 || health?.name !== MCP_SERVER_NAME) {
      this.holderProblem = null;
    } else if (health.protocol !== BRIDGE_PROTOCOL_VERSION || health.share !== SHARE_PROTOCOL) {
      this.holderProblem = `Another Canvas MCP server (${health.version ?? 'an unknown version'}) owns port ${port} and cannot share its canvas with this one (${MCP_SERVER_VERSION}): their bridge protocols differ. `
        + 'Restart the older agent session (or update its canvas) so both run the same version; until then this one can only edit files (openflow_open).';
    } else {
      this.holder = health as BridgeHealth;
      this.holderProblem = null;
      if (!wasGuest) this.options.log?.(`Port ${port} belongs to ${health.name} ${health.version ?? ''} (another agent session); sharing its canvas.`);
      return 'shared';
    }
    return 'refused';
  }

  /** One request to whoever owns the bridge port, as a local server (no Origin, JSON, this server's token). */
  private local(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 2000): Promise<{ status: number; body: unknown }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        // A fresh socket each time: a kept-alive one to a holder that since exited fails as a reset, not as "nobody here".
        host: '127.0.0.1', port: this.options.port, path, method, timeout: timeoutMs, agent: false,
        headers: {
          ...(this.options.token ? { [bridgeTokenHeader]: this.options.token } : {}),
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          let parsed: unknown = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON: not a Canvas server */ }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      });
      request.on('timeout', () => request.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      request.on('error', reject);
      request.end(payload);
    });
  }

  /** Hands the next queued request to the parked poll, if both are waiting. */
  private flush(): void {
    if (!this.parked || this.queue.length === 0) return;
    const response = this.parked;
    this.parked = null;
    const request = this.queue.shift()!;
    this.respond(response, 200, request);
  }

  // Every reply, including the empty 204 that closes a poll, carries the CORS
  // headers: without them the browser rejects the fetch and the editor flaps
  // between "connected" and "unavailable" every poll window.
  private respond(response: ServerResponse, status: number, body: unknown): void {
    const origin = response.req.headers.origin;
    response.writeHead(status, {
      ...(status === 204 ? {} : { 'content-type': 'application/json;charset=utf-8' }),
      'cache-control': 'no-store',
      // Only an allowed origin may read a reply; a refused one learns nothing, not even its own 403.
      ...(isAllowedBridgeOrigin(origin) && origin ? { 'access-control-allow-origin': origin } : {}),
      'access-control-allow-headers': `content-type, ${bridgeTokenHeader}`,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      // Chrome asks before a public page may reach 127.0.0.1.
      'access-control-allow-private-network': 'true',
    });
    response.end(status === 204 ? undefined : JSON.stringify(body));
  }

  private reject401(response: ServerResponse, request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    // A browser no-cors GET or <img> carries no Origin but does say which site sent it; curl and Node send neither.
    const site = request.headers['sec-fetch-site'];
    if (!isAllowedBridgeOrigin(origin) || (!origin && (site === 'cross-site' || site === 'same-site'))) {
      this.respond(response, 403, { error: 'Origin not allowed. The bridge is local-only.' });
      return true;
    }
    if (!this.options.token) return false;
    // The editor sends it as `?token=` (a plain request, so no preflight an older server could not answer); CLIs may use the header.
    const supplied = request.headers[bridgeTokenHeader] ?? new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('token');
    if (supplied === this.options.token) return false;
    // Only an editor's knock counts for "an editor was refused"; a guest server's has its own message.
    if (/^\/(hello|next)$/.test(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)) this.refusedAt = Date.now();
    this.respond(response, 401, { error: `Missing or wrong ${bridgeTokenHeader}.` });
    return true;
  }

  private async body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return null;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    try {
      // A same-origin request from a rebound name carries no Origin header, so the Host is checked first.
      if (!isAllowedBridgeHost(request.headers.host)) {
        this.respond(response, 403, { error: 'Host not allowed. The bridge answers 127.0.0.1, localhost and [::1] only.' });
        return;
      }
      if (url.pathname === '/call' && (request.method !== 'POST' || isFromBrowser(request))) {
        this.respond(response, 403, { error: '/call is for Canvas MCP servers on this machine, not web pages.' });
        return;
      }
      // A preflight cannot carry the token it asks permission to send: origin-check it, nothing more.
      if (request.method === 'OPTIONS') {
        if (isAllowedBridgeOrigin(request.headers.origin)) this.respond(response, 204, null);
        else this.respond(response, 403, { error: 'Origin not allowed. The bridge is local-only.' });
        return;
      }
      if (this.reject401(response, request)) return;
      if (request.method === 'GET' && url.pathname === '/health') { this.respond(response, 200, this.health()); return; }
      if (request.method === 'POST' && url.pathname === '/hello') {
        const document = (await this.body(request) as { document?: unknown } | null)?.document;
        if (!isBridgeClientInfo(document)) {
          this.respond(response, 400, { error: 'hello needs a document summary.' });
          return;
        }
        const wasConnected = this.connected;
        const tab = url.searchParams.get('tab');
        // A new tab takes over: the old tab's parked poll hears so now, not after its window.
        if (tab && this.parked && this.parkedTab !== null && this.parkedTab !== tab) {
          const displaced = this.parked;
          this.parked = null;
          this.respond(displaced, 409, { error: TAB_TAKEN });
        }
        this.tab = tab;
        this.client = { ...document, origin: request.headers.origin ?? null };
        this.gone = false;
        this.lastSeenAt = Date.now();
        this.options.log?.(`Editor connected: "${document.name}" (${document.pages.length} page(s))${wasConnected ? ' [replaced]' : ''}`);
        this.toldChannel = this.channelSource();
        this.respond(response, 200, { ok: true, protocol: BRIDGE_PROTOCOL_VERSION, channel: this.toldChannel });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/event') {
        const event = await this.body(request);
        if (!isBridgeThreadEvent(event)) { this.respond(response, 400, { error: 'event needs a thread event.' }); return; }
        try { this.eventSink?.(event); } catch { /* best effort: a session that cannot take it must not fail the editor */ }
        this.respond(response, 200, { ok: true });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/next') { this.next(response, url); return; }
      if (url.pathname === '/call') { await this.serveCall(request, response); return; }
      if (request.method === 'POST' && url.pathname === '/result') {
        const payload = await this.body(request) as { id?: string; ok?: boolean; output?: unknown; error?: string } | null;
        const call = payload?.id ? this.pending.get(payload.id) : undefined;
        if (!call || !payload) { this.respond(response, 200, { ok: false, error: 'No such request.' }); return; }
        clearTimeout(call.timer);
        this.pending.delete(payload.id!);
        this.lastSeenAt = Date.now();
        if (payload.ok) call.resolve(payload.output);
        else call.reject(new Error(payload.error ?? 'The editor reported an error.'));
        this.respond(response, 200, { ok: true });
        return;
      }
      this.respond(response, 404, { error: `Unknown bridge route ${request.method} ${url.pathname}.` });
    } catch (error) {
      this.respond(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Holder: one op from a guest server, run exactly like a local call. */
  private async serveCall(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await this.body(request) as { op?: unknown; input?: unknown; pageId?: unknown; client?: unknown } | null;
    if (typeof payload?.op !== 'string') { this.respond(response, 400, { error: 'call needs an op.' }); return; }
    const agent = typeof payload.client === 'string' ? payload.client.slice(0, 100) : undefined;
    this.guests.set(agent ?? 'an unnamed agent', Date.now());
    try {
      const output = await this.call(payload.op, payload.input, typeof payload.pageId === 'string' ? payload.pageId : undefined, agent);
      this.respond(response, 200, { ok: true, output, health: this.health() });
    } catch (error) {
      this.respond(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error), health: this.health() });
    }
  }

  private next(response: ServerResponse, url: URL): void {
    const tab = url.searchParams.get('tab');
    if (tab && this.tab && tab !== this.tab) { this.respond(response, 409, { error: TAB_TAKEN }); return; }
    this.lastSeenAt = Date.now();
    if (this.parked) { this.respond(this.parked, 204, null); this.parked = null; }
    if (this.queue.length > 0) {
      this.respond(response, 200, this.queue.shift());
      return;
    }
    // The client declares its channel at initialize, which can come after the editor's hello: the poll carries the news.
    const channel = this.channelSource();
    if (this.toldChannel !== null && this.toldChannel !== channel) {
      this.toldChannel = channel;
      this.respond(response, 200, { channel });
      return;
    }
    const waitSeconds = Math.min(60, Math.max(1, Number(url.searchParams.get('wait')) || BRIDGE_POLL_SECONDS));
    // Headers are deliberately not sent while parked: the poll stays pending
    // until there is a request (200) or the window closes (204).
    this.parked = response;
    this.parkedTab = tab;
    const timer = setTimeout(() => {
      if (this.parked === response) {
        this.parked = null;
        this.respond(response, 204, null);
      }
    }, waitSeconds * 1000);
    // Closed while still parked (we reply to a poll before we drop it): the tab closed, reloaded or stopped polling.
    response.on('close', () => { clearTimeout(timer); if (this.parked === response) this.editorGone(); });
  }

  private editorGone(): void {
    this.parked = null;
    this.lastSeenAt = null;
    this.gone = true;
    this.queue.length = 0;
    for (const [, call] of this.pending) { clearTimeout(call.timer); call.reject(new Error(EDITOR_GONE)); }
    this.pending.clear();
    this.options.log?.('Editor disconnected (its tab closed or reloaded).');
  }
}
