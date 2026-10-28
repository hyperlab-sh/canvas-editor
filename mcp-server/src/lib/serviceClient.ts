// The MCP server as a client of the local service: finds it or starts it (D10), registers one session,
// holds the session's diagram bindings, runs ops on them, and hands the session's comments to a listener.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeThreadEvent } from './agent.js';

export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:43120';
/** How long `ensure` waits for a service it started to answer. */
const START_WAIT_MS = 10_000;
const POLL_MS = 250;
/** Matches the service's longest park, so a parked poll is the session's heartbeat. */
const EVENT_WAIT_S = 25;
const RETRY_MS = 1_000;

export interface ServiceBinding {
  readonly project: string;
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

export interface ServiceProject {
  readonly name: string;
  readonly diagrams: readonly { readonly id: string; readonly title: string; readonly holder: { readonly label: string } | null }[];
}

export interface ServiceOptions {
  /** Service base URL; defaults to OPENFLOWKIT_SERVICE_URL, else http://127.0.0.1:43120. */
  readonly url?: string;
  /** The MCP client's name, known only after initialize. */
  readonly clientName: () => string | undefined;
  readonly log?: (message: string) => void;
}

type Health = { readonly state: 'up'; readonly pid: number } | { readonly state: 'foreign' } | { readonly state: 'down' };

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** `node <cli> serve`, from the compiled package or (in dev and tests) the TypeScript source through tsx. */
function serveCommand(port: string): { command: string; args: string[]; cwd: string } {
  const here = fileURLToPath(import.meta.url);
  const cli = resolve(dirname(here), '..', here.endsWith('.ts') ? 'cli.ts' : 'cli.js');
  const tsx = here.endsWith('.ts') ? ['--import', 'tsx'] : [];
  return { command: process.execPath, args: [...tsx, cli, 'serve', '--port', port], cwd: resolve(dirname(here), '..', '..') };
}

export class ServiceClient {
  readonly url: string;
  private readonly clientName: () => string | undefined;
  private readonly log: (message: string) => void;
  private sessionId: string | null = null;
  private label: string | null = null;
  private servicePid: number | null = null;
  private starting: Promise<void> | null = null;
  private registering: Promise<void> | null = null;
  private listeners: ((event: BridgeThreadEvent) => void)[] = [];
  private polling: AbortController | null = null;
  private closed = false;

  constructor(options: ServiceOptions) {
    this.url = (options.url ?? process.env.OPENFLOWKIT_SERVICE_URL ?? DEFAULT_SERVICE_URL).replace(/\/+$/, '');
    this.clientName = options.clientName;
    this.log = options.log ?? ((message) => console.error(message));
  }

  private get port(): string {
    return new URL(this.url).port || '80';
  }

  /** What the operator reads when the port answers as something else (R-5). */
  private foreignMessage(): string {
    return `Port ${this.port} is in use by something that is not the OpenFlowKit service. `
      + `Change "port" in the service config (~/.config/openflowkit/service.json) and set OPENFLOWKIT_SERVICE_URL to match, or free the port.`;
  }

  private async health(): Promise<Health> {
    try {
      const reply = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
      const body = await reply.json() as { service?: unknown; pid?: unknown };
      return body.service === 'openflowkit-service' && typeof body.pid === 'number' ? { state: 'up', pid: body.pid } : { state: 'foreign' };
    } catch (error) {
      // A reply that is not JSON came from another program; no reply at all means nothing listens.
      return error instanceof SyntaxError ? { state: 'foreign' } : { state: 'down' };
    }
  }

  /** Starts `serve` detached and waits until it answers. A second caller waits on the first's start. */
  private start(): Promise<void> {
    this.starting ??= (async () => {
      const { command, args, cwd } = serveCommand(this.port);
      const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
      let failed: number | null = null;
      child.once('error', () => { failed = -1; });
      // Exit 0 is "already running" (another MCP server won the race); anything else is the port refusal.
      child.once('exit', (code) => { if (code) failed = code; });
      child.unref();
      const deadline = Date.now() + START_WAIT_MS;
      while (Date.now() < deadline) {
        const health = await this.health();
        if (health.state === 'up') return;
        if (health.state === 'foreign' || failed !== null) throw new Error(this.foreignMessage());
        await sleep(POLL_MS);
      }
      throw new Error(`The OpenFlowKit service did not answer on ${this.url} within ${START_WAIT_MS / 1000} s. Run "openflowkit serve" to see why.`);
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  /**
   * Makes sure a service answers, starting one when none does (D10), and that this session is registered with it.
   * A service that restarted (new pid) lost the session and its bindings: registering again is the cure.
   */
  async ensure(): Promise<void> {
    let health = await this.health();
    if (health.state === 'foreign') throw new Error(this.foreignMessage());
    if (health.state === 'down') {
      await this.start();
      health = await this.health();
    }
    if (health.state !== 'up') throw new Error(this.foreignMessage());
    await this.register(health.pid);
  }

  private register(pid: number): Promise<void> {
    if (this.sessionId && this.servicePid === pid) return Promise.resolve();
    this.registering ??= (async () => {
      const reply = await this.request('POST', '/sessions', { client: this.clientName() ?? 'MCP client', cwd: process.cwd(), pid: process.pid }, false);
      const body = reply.json as { sessionId: string; label: string };
      this.sessionId = body.sessionId;
      this.label = body.label;
      this.servicePid = pid;
      this.poll(body.sessionId);
    })().finally(() => { this.registering = null; });
    return this.registering;
  }

  private async request(method: string, path: string, body?: unknown, ensured = true): Promise<{ status: number; json: unknown }> {
    if (ensured) await this.ensure();
    const reply = await fetch(`${this.url}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await reply.text();
    let json: unknown;
    try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
    return { status: reply.status, json };
  }

  /** A failed request becomes the service's own sentence. */
  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const { status, json } = await this.request(method, path, body);
    if (status >= 400) throw new Error((json as { error?: string } | undefined)?.error ?? `The service answered ${status} for ${method} ${path}.`);
    return json;
  }

  /** The session's comment stream. Runs from registration on; a parked poll is the session's heartbeat. */
  private poll(sessionId: string): void {
    this.polling?.abort();
    const controller = new AbortController();
    this.polling = controller;
    void (async () => {
      while (!this.closed && !controller.signal.aborted && this.sessionId === sessionId) {
        try {
          const reply = await fetch(`${this.url}/sessions/${sessionId}/events?wait=${EVENT_WAIT_S}`, { signal: controller.signal });
          if (reply.status === 200) {
            const { events } = await reply.json() as { events: BridgeThreadEvent[] };
            for (const event of events) for (const listener of this.listeners) listener(event);
          } else if (reply.status === 404) {
            // The service forgot the session (it restarted): the next tool call registers again.
            this.sessionId = null;
            this.servicePid = null;
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          this.log(`openflowkit: service event stream: ${error instanceof Error ? error.message : String(error)}`);
          await sleep(RETRY_MS);
        }
      }
    })();
  }

  /** Receives each thread event the service hands this session. */
  onEvent(listener: (event: BridgeThreadEvent) => void): void {
    this.listeners.push(listener);
  }

  /** Stops the event stream. The service keeps running: it belongs to the user, not to this process. */
  close(): void {
    this.closed = true;
    this.polling?.abort();
  }

  /** True once this session has talked to the service; before that no tool should start one. */
  get registered(): boolean {
    return this.sessionId !== null;
  }

  link(project: string, id: string): string {
    return `${this.url}/#/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
  }

  async projects(): Promise<ServiceProject[]> {
    return await this.call('GET', '/projects') as ServiceProject[];
  }

  /**
   * The diagrams this session holds, as the service sees them: the app's Disconnect or a sweep takes one away
   * without telling this process. Never starts a service.
   */
  async bindings(): Promise<ServiceBinding[]> {
    if (!this.sessionId || (await this.health()).state !== 'up') return [];
    await this.ensure();
    if (!this.label) return [];
    const mine = (await this.projects()).flatMap(({ name, diagrams }) =>
      diagrams.filter((diagram) => diagram.holder?.label === this.label).map((diagram) => ({ project: name, id: diagram.id, title: diagram.title, url: this.link(name, diagram.id) })));
    return mine;
  }

  async create(project: string, name: string): Promise<{ id: string; url: string }> {
    const created = await this.call('POST', `/projects/${encodeURIComponent(project)}/diagrams`, { name }) as { id: string; url: string };
    await this.bind(project, created.id);
    return created;
  }

  /** Binds; the service refuses with the holder's label when another session has the diagram (D13). */
  async bind(project: string, id: string): Promise<ServiceBinding> {
    const { diagram } = await this.call('POST', `/sessions/${this.sessionId}/bindings`, { project, id }) as { diagram: { title: string } };
    return { project, id, title: diagram.title, url: this.link(project, id) };
  }

  async unbind(project: string, id: string): Promise<void> {
    await this.call('DELETE', `/sessions/${this.sessionId}/bindings/${encodeURIComponent(project)}/${encodeURIComponent(id)}`);
  }

  async runOp(binding: Pick<ServiceBinding, 'project' | 'id'>, op: string, input: unknown, pageId?: string): Promise<unknown> {
    const reply = await this.call('POST', `/sessions/${this.sessionId}/ops`, { project: binding.project, id: binding.id, op, input, ...(pageId ? { pageId } : {}) }) as { output: unknown };
    return reply.output;
  }

  /** For `server_info` and `whoami`: never starts the service. */
  async status(): Promise<{ url: string; running: boolean; sessionId: string | null; label: string | null; bindings: ServiceBinding[] }> {
    const running = (await this.health()).state === 'up';
    const bindings = running ? await this.bindings().catch(() => []) : [];
    return { url: this.url, running, sessionId: this.sessionId, label: this.label, bindings };
  }
}
