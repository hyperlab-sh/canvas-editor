// The MCP server as a client of the local service: finds it or starts it (D10), registers one session,
// holds the session's diagram bindings, runs ops on them, and hands the session's comments to a listener.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeThreadEvent } from './agent.js';

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:43120';
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

/** `node <cli> serve`, always on loopback (the client polls 127.0.0.1), from the compiled package or (in dev and tests) the TypeScript source through tsx. */
function serveCommand(port: string): { command: string; args: string[]; cwd: string } {
  const here = fileURLToPath(import.meta.url);
  const cli = resolve(dirname(here), '..', here.endsWith('.ts') ? 'cli.ts' : 'cli.js');
  const tsx = here.endsWith('.ts') ? ['--import', 'tsx'] : [];
  return { command: process.execPath, args: [...tsx, cli, 'serve', '--port', port, '--host', '127.0.0.1'], cwd: resolve(dirname(here), '..', '..') };
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
  /** Whether this session can receive the comments it registers for; told to the service, which tells the editor. */
  private channel: () => boolean = () => false;
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
      // `serve` exits 1 only for a port held by another program; any other code or a spawn error is a different problem.
      let failure: string | null = null;
      child.once('error', (error) => { failure = `Could not start the OpenFlowKit service (${error.message}).`; });
      child.once('exit', (code) => {
        if (code === 1) failure = this.foreignMessage();
        else if (code) failure = `The OpenFlowKit service exited with code ${code}. Run "openflowkit serve" to see why.`;
      });
      child.unref();
      const deadline = Date.now() + START_WAIT_MS;
      while (Date.now() < deadline) {
        const health = await this.health();
        if (health.state === 'up') return;
        if (health.state === 'foreign') throw new Error(this.foreignMessage());
        if (failure !== null) throw new Error(failure);
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
  async ensure(start = true): Promise<void> {
    let health = await this.health();
    if (health.state === 'foreign') throw new Error(this.foreignMessage());
    if (health.state === 'down') {
      if (!start) throw new Error('The OpenFlowKit service is not running.');
      await this.start();
      health = await this.health();
    }
    if (health.state !== 'up') throw new Error(this.foreignMessage());
    await this.register(health.pid);
  }

  /** True when a service already answers; never starts one. */
  async running(): Promise<boolean> {
    return (await this.health()).state === 'up';
  }

  private register(pid: number): Promise<void> {
    if (this.sessionId && this.servicePid === pid) return Promise.resolve();
    this.registering ??= (async () => {
      const reply = await this.request('POST', '/sessions', { client: this.clientName() ?? 'MCP client', cwd: process.cwd(), pid: process.pid, channel: this.channel() });
      const body = reply.json as { sessionId: string; label: string };
      this.sessionId = body.sessionId;
      this.label = body.label;
      this.servicePid = pid;
      this.poll(body.sessionId);
    })().finally(() => { this.registering = null; });
    return this.registering;
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
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

  /**
   * One call to the service. A registered session talks straight away; a service that went away (no answer) or
   * forgot the session (404 on a session path) is met once with a fresh registration. The path is built after
   * registration, so it never carries a session id that was reset in between.
   */
  private async call(method: string, path: string | ((sessionId: string) => string), body?: unknown, start = true): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      if (!this.sessionId || attempt > 0) await this.ensure(start);
      const target = typeof path === 'string' ? path : path(this.sessionId!);
      let reply: { status: number; json: unknown };
      try {
        reply = await this.request(method, target, body);
      } catch (error) {
        // The same service, still up, answered badly or not in time: the session and what it holds are intact, and the
        // request may already have run, so it is neither forgotten nor sent again.
        const health = await this.health();
        if (attempt > 0 || (health.state === 'up' && health.pid === this.servicePid)) throw error;
        this.forget();
        continue;
      }
      // Only "no such session" means the service restarted; a 404 for a missing project or diagram is the caller's to read.
      if (reply.status === 404 && typeof path !== 'string' && attempt === 0 && /^Unknown session/.test((reply.json as { error?: string } | undefined)?.error ?? '')) {
        this.forget();
        continue;
      }
      if (reply.status >= 400) throw new Error((reply.json as { error?: string } | undefined)?.error ?? `The service answered ${reply.status} for ${method} ${target}.`);
      return reply.json;
    }
  }

  private forget(): void {
    this.sessionId = null;
    this.servicePid = null;
  }

  /** The session's comment stream. Runs from registration on; a parked poll is the session's heartbeat. */
  private poll(sessionId: string): void {
    this.polling?.abort();
    const controller = new AbortController();
    this.polling = controller;
    void (async () => {
      let broken = false;
      while (!this.closed && !controller.signal.aborted && this.sessionId === sessionId) {
        try {
          const reply = await fetch(`${this.url}/sessions/${sessionId}/events?wait=${EVENT_WAIT_S}`, { signal: controller.signal });
          if (broken) this.log('openflowkit: service event stream is back.');
          broken = false;
          if (reply.status === 200) {
            const { events } = await reply.json() as { events: BridgeThreadEvent[] };
            for (const event of events) for (const listener of this.listeners) listener(event);
          } else if (reply.status === 404) {
            // The service forgot the session (it restarted): the next tool call registers again.
            this.forget();
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          // Once per outage, not once per retry.
          if (!broken) this.log(`openflowkit: service event stream broke: ${error instanceof Error ? error.message : String(error)}`);
          broken = true;
          await sleep(RETRY_MS);
        }
      }
    })();
  }

  /** Receives each thread event the service hands this session. */
  onEvent(listener: (event: BridgeThreadEvent) => void): void {
    this.listeners.push(listener);
  }

  /** Whether the events reach the session's model. Read at registration, which follows the client's initialize. */
  channelFrom(source: () => boolean): void {
    this.channel = source;
  }

  /** Stops the event stream. The service keeps running: it belongs to the user, not to this process. */
  close(): void {
    this.closed = true;
    this.polling?.abort();
  }

  link(project: string, id: string): string {
    return `${this.url}/#/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
  }

  async projects(): Promise<ServiceProject[]> {
    return await this.call('GET', '/projects') as ServiceProject[];
  }

  /**
   * The projects and the diagrams this session holds in them, from one listing. The app's Disconnect or a sweep
   * takes a diagram away without telling this process, so the service is asked, not remembered. Never starts a
   * service: `projects` is null when this session has not used it or it is not answering.
   */
  async view(): Promise<{ projects: ServiceProject[] | null; bindings: ServiceBinding[] }> {
    if (!this.sessionId) return { projects: null, bindings: [] };
    let projects: ServiceProject[];
    try {
      projects = await this.call('GET', '/projects', undefined, false) as ServiceProject[];
    } catch {
      return { projects: null, bindings: [] };
    }
    return { projects, bindings: this.heldIn(projects) };
  }

  /** Held by the session whose label this is. Labels are unique among live sessions (see the PR's follow-up on session-keyed bindings). */
  private heldIn(projects: readonly ServiceProject[]): ServiceBinding[] {
    return projects.flatMap(({ name, diagrams }) =>
      diagrams.filter((diagram) => diagram.holder?.label === this.label).map((diagram) => ({ project: name, id: diagram.id, title: diagram.title, url: this.link(name, diagram.id) })));
  }

  async bindings(): Promise<ServiceBinding[]> {
    return (await this.view()).bindings;
  }

  async create(project: string, name: string): Promise<{ id: string; url: string }> {
    const created = await this.call('POST', `/projects/${encodeURIComponent(project)}/diagrams`, { name }) as { id: string; url: string };
    await this.bind(project, created.id);
    return created;
  }

  /** Binds; the service refuses with the holder's label when another session has the diagram (D13). */
  async bind(project: string, id: string): Promise<ServiceBinding> {
    const { diagram } = await this.call('POST', (sid) => `/sessions/${sid}/bindings`, { project, id }) as { diagram: { title: string } };
    return { project, id, title: diagram.title, url: this.link(project, id) };
  }

  async unbind(project: string, id: string): Promise<void> {
    await this.call('DELETE', (sid) => `/sessions/${sid}/bindings/${encodeURIComponent(project)}/${encodeURIComponent(id)}`);
  }

  async runOp(binding: Pick<ServiceBinding, 'project' | 'id'>, op: string, input: unknown, pageId?: string): Promise<unknown> {
    const reply = await this.call('POST', (sid) => `/sessions/${sid}/ops`, { project: binding.project, id: binding.id, op, input, ...(pageId ? { pageId } : {}) }) as { output: unknown };
    return reply.output;
  }

  /** For `server_info` and `whoami`: never starts the service. */
  async status(): Promise<{ url: string; running: boolean; sessionId: string | null; label: string | null; bindings: ServiceBinding[] }> {
    const running = await this.running();
    const bindings = running ? await this.bindings() : [];
    return { url: this.url, running, sessionId: this.sessionId, label: this.label, bindings };
  }
}
