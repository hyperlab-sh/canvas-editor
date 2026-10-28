import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { isAllowedBridgeOrigin, isBridgeThreadEvent, parseAgentDocument } from '../lib/agent.js';
import { MCP_SERVER_VERSION } from '../lib/version.js';
import type { ServiceConfig } from './config.js';
import { MAX_WAIT_S, type Events } from './events.js';
import { runOp } from './ops.js';
import { ConflictError, listDiagrams, NotFoundError } from './projects.js';
import type { Sessions } from './sessions.js';
import type { Store } from './store.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface ServiceDeps {
  readonly config: ServiceConfig;
  readonly store: Store;
  readonly sessions: Sessions;
  readonly events: Events;
  /** Directory of the built app. */
  readonly appDir: string;
  /** The port the server is bound to; read per request because port 0 is only known after listen. */
  readonly port: () => number;
}

export interface RouteContext {
  readonly request: IncomingMessage;
  readonly url: URL;
  /** The decoded `:name` segment of the matched path. */
  param(name: string): string;
  readonly deps: ServiceDeps;
  /** The JSON body; null when the request had none. Throws HttpError(400/413) when it cannot be read. */
  body(): Promise<unknown>;
}

export interface RouteReply {
  readonly status: number;
  /** JSON-encoded unless `raw` is set. */
  readonly json?: unknown;
  /** Takes over the response (an SSE stream); the handler sends nothing else. */
  readonly stream?: (response: ServerResponse) => void;
  readonly raw?: { readonly type: string; readonly data: Buffer | string; readonly headers?: Record<string, string> };
}

/** A path like `/projects/:p/diagrams/:id`; later units add their rows to the table `createHandler` takes. */
export interface Route {
  readonly method: string;
  readonly path: string;
  handle(context: RouteContext): Promise<RouteReply>;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** This machine by name: a rebound DNS name (evil.example → 127.0.0.1) is refused. Any port, so a forward still works. */
const isAllowedHost = (host: string | undefined): boolean =>
  /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host?.toLowerCase() ?? '');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

/** The app's baseline headers from `public/_headers`, without the CDN-only script sources. */
const APP_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function requireBody(context: RouteContext): Promise<Record<string, unknown>> {
  const body = await context.body();
  if (!isRecord(body)) throw new HttpError(400, 'The request needs a JSON object body.');
  return body;
}

/** The holder as the API shows it: `{label}`, or null when no session holds the diagram. */
const holderOf = (deps: ServiceDeps, project: string, id: string): { label: string } | null => {
  const holder = deps.sessions.holderOf(project, id);
  return holder ? { label: holder.label } : null;
};

/** The session in the path, or a 404 that tells the client to register again. */
function sessionOf(context: RouteContext): string {
  const id = context.param('sid');
  if (!context.deps.sessions.get(id)) throw new HttpError(404, `Unknown session ${id}. Register again.`);
  return id;
}

async function readDiagramRef(context: RouteContext): Promise<{ project: string; id: string }> {
  const { project, id } = await requireBody(context);
  if (typeof project !== 'string' || typeof id !== 'string' || !project || !id) throw new HttpError(400, 'The body needs a "project" and an "id".');
  return { project, id };
}

async function serveApp(context: RouteContext): Promise<RouteReply> {
  const { appDir } = context.deps;
  const index = join(appDir, 'index.html');
  const send = async (file: string, immutable: boolean): Promise<RouteReply> => ({
    status: 200,
    raw: {
      type: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      data: await readFile(file),
      headers: immutable ? { 'cache-control': 'public, max-age=31536000, immutable' } : { 'cache-control': 'no-cache' },
    },
  });
  if (!(await stat(index).catch(() => null))?.isFile()) {
    return { status: 503, raw: { type: 'text/plain; charset=utf-8', data: `The app is not built: ${index} does not exist. Build it, or point --app / OPENFLOWKIT_APP_DIR at the build.\n` } };
  }
  let relative: string;
  try {
    relative = normalize(decodeURIComponent(context.url.pathname));
  } catch {
    return send(index, false);
  }
  // The request path is rooted, so normalising it first cannot leave the app folder (`/../x` becomes `/x`).
  const file = join(appDir, relative);
  if ((await stat(file).catch(() => null))?.isFile()) {
    return send(file, relative.startsWith(`${sep}assets${sep}`));
  }
  return send(index, false);
}

export function buildRoutes(): Route[] {
  const diagramUrl = (port: number, project: string, id: string): string =>
    `http://127.0.0.1:${port}/#/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;

  return [
    {
      method: 'GET', path: '/health',
      handle: async ({ deps }) => ({
        status: 200,
        json: { ok: true, service: 'openflowkit-service', version: MCP_SERVER_VERSION, port: deps.port(), projects: deps.config.projects.map((p) => p.name), pid: process.pid },
      }),
    },
    {
      method: 'GET', path: '/projects',
      handle: async ({ deps }) => {
        const listing = await listDiagrams(deps.config);
        return {
          status: 200,
          json: listing.map(({ name, diagrams }) => ({
            name,
            path: deps.config.projects.find((p) => p.name === name)?.path,
            diagrams: diagrams.map((d) => ({ ...d, holder: holderOf(deps, name, d.id) })),
          })),
        };
      },
    },
    {
      method: 'POST', path: '/projects/:p/diagrams',
      handle: async (context) => {
        const { name } = await requireBody(context);
        if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Creating a diagram needs a "name".');
        const created = await context.deps.store.create(context.param('p'), name.trim());
        return { status: 201, json: { id: created.id, project: created.project, url: diagramUrl(context.deps.port(), created.project, created.id), revision: created.revision } };
      },
    },
    {
      method: 'GET', path: '/projects/:p/diagrams/:id',
      handle: async ({ deps, param }) => {
        const { document, revision } = await deps.store.read(param('p'), param('id'));
        return { status: 200, json: { document, revision, holder: holderOf(deps, param('p'), param('id')) } };
      },
    },
    {
      method: 'PUT', path: '/projects/:p/diagrams/:id',
      handle: async (context) => {
        const { document, revision } = await requireBody(context);
        if (typeof revision !== 'number' || !Number.isFinite(revision)) throw new HttpError(400, 'Saving needs the "revision" you last loaded.');
        let parsed;
        try {
          parsed = parseAgentDocument(document);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : 'The document is not valid.');
        }
        if (parsed.id !== context.param('id')) {
          throw new HttpError(400, `Document id "${parsed.id}" does not match diagram "${context.param('id')}".`);
        }
        const result = await context.deps.store.write(context.param('p'), context.param('id'), parsed, revision);
        if (result.status === 'stale') return { status: 409, json: { revision: result.revision, document: result.document } };
        return { status: 200, json: { revision: result.revision } };
      },
    },
    {
      method: 'PATCH', path: '/projects/:p/diagrams/:id',
      handle: async (context) => {
        const { name } = await requireBody(context);
        if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Renaming needs a "name".');
        const { store } = context.deps;
        const p = context.param('p');
        const id = context.param('id');
        // A write that lost the race to another save is re-read and retried up to twice, so a rename never overwrites the winner.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await store.read(p, id);
          const result = await store.write(p, id, { ...current.document, name: name.trim() }, current.revision);
          if (result.status === 'ok') return { status: 200, json: { revision: result.revision } };
        }
        throw new HttpError(409, 'The diagram kept changing; try the rename again.');
      },
    },
    {
      method: 'GET', path: '/events',
      handle: async ({ url, deps }) => {
        const project = url.searchParams.get('project');
        const id = url.searchParams.get('id');
        if (!project || !id) throw new HttpError(400, 'The stream needs ?project= and ?id=.');
        return { status: 200, stream: (response) => deps.events.subscribe(project, id, response) };
      },
    },
    {
      method: 'POST', path: '/sessions',
      handle: async (context) => {
        const { client, cwd, pid } = await requireBody(context);
        if (typeof cwd !== 'string' || !cwd) throw new HttpError(400, 'Registering needs the "cwd".');
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) throw new HttpError(400, 'Registering needs the "pid".');
        const label = typeof client === 'string' && client ? client : 'MCP client';
        return { status: 201, json: context.deps.sessions.register({ client: label, cwd, pid }) };
      },
    },
    {
      method: 'GET', path: '/sessions/:sid/events',
      handle: async (context) => {
        const sid = sessionOf(context);
        // HEAD answers at once; it must not park.
        const wait = context.request.method === 'HEAD' ? 0 : Number(context.url.searchParams.get('wait') ?? MAX_WAIT_S);
        const events = await context.deps.events.poll(sid, Number.isFinite(wait) ? wait : MAX_WAIT_S, context.request);
        return events ? { status: 200, json: { events } } : { status: 204 };
      },
    },
    {
      method: 'POST', path: '/sessions/:sid/bindings',
      handle: async (context) => {
        const sid = sessionOf(context);
        const { project, id } = await readDiagramRef(context);
        // Reading proves the diagram exists (404) before anything holds it.
        const { document } = await context.deps.store.read(project, id);
        const bound = context.deps.sessions.bind(sid, project, id);
        if (bound.status === 'gone') throw new HttpError(404, `Unknown session ${sid}. Register again.`);
        if (bound.status === 'held') return { status: 409, json: { error: `${project}/${id} is connected to ${bound.holder}.`, holder: bound.holder } };
        return { status: 200, json: { diagram: { project, id, title: document.name } } };
      },
    },
    {
      method: 'DELETE', path: '/sessions/:sid/bindings/:p/:id',
      handle: async (context) => {
        context.deps.sessions.unbind(sessionOf(context), context.param('p'), context.param('id'));
        return { status: 204 };
      },
    },
    {
      method: 'POST', path: '/sessions/:sid/ops',
      handle: async (context) => {
        const sid = sessionOf(context);
        const { project, id, op, input, pageId } = await requireBody(context);
        if (typeof project !== 'string' || typeof id !== 'string' || typeof op !== 'string') throw new HttpError(400, 'An op needs "project", "id" and "op".');
        if (pageId !== undefined && typeof pageId !== 'string') throw new HttpError(400, '"pageId" must be a string.');
        const { status, ...reply } = await runOp(context.deps.sessions, context.deps.store, sid, { project, id, op, input: input ?? {}, ...(pageId ? { pageId } : {}) });
        return { status, json: reply };
      },
    },
    {
      method: 'DELETE', path: '/projects/:p/diagrams/:id/holder',
      handle: async ({ deps, param }) => {
        deps.sessions.disconnect(param('p'), param('id'));
        return { status: 204 };
      },
    },
    {
      method: 'POST', path: '/projects/:p/diagrams/:id/comments',
      handle: async (context) => {
        const event = await context.body();
        if (!isBridgeThreadEvent(event)) throw new HttpError(400, 'The body is not a thread event.');
        if (event.documentId !== context.param('id')) throw new HttpError(400, `The event is for document "${event.documentId}", not "${context.param('id')}".`);
        const holder = context.deps.sessions.holderOf(context.param('p'), context.param('id'));
        if (!holder) return { status: 409, json: { error: 'No session holds this diagram' } };
        context.deps.events.push(holder.id, event);
        return { status: 202 };
      },
    },
  ];
}

/** Answers every GET the API did not: the app, with `index.html` for the hash router. Always last. */
const appRoute: Route = { method: 'GET', path: '/*', handle: serveApp };

function compile(path: string): { pattern: RegExp; names: string[] } {
  const names: string[] = [];
  if (path === '/*') return { pattern: /^\/.*$/, names };
  const source = path.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(segment.slice(1));
    return '([^/]+)';
  }).join('/');
  return { pattern: new RegExp(`^${source}/?$`), names };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  // A declared length over the limit is refused before reading a byte; the streaming check covers chunked bodies.
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

/** The request listener. `routes` are tried in order, then the app fallback. */
export function createHandler(deps: ServiceDeps, routes: readonly Route[] = buildRoutes()) {
  const compiled = [...routes, appRoute].map((route) => ({ route, ...compile(route.path) }));

  const send = (response: ServerResponse, reply: RouteReply, head = false): void => {
    if (reply.stream) {
      if (head) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', ...APP_HEADERS });
        return void response.end();
      }
      return reply.stream(response);
    }
    if (reply.status === 204) {
      response.writeHead(204, { 'cache-control': 'no-store', ...APP_HEADERS });
      return void response.end();
    }
    // The unread upload of a refused oversize body must not keep the connection busy.
    const close = reply.status === 413 ? { connection: 'close' } : {};
    const data = reply.raw ? reply.raw.data : JSON.stringify(reply.json ?? null);
    const headers = reply.raw
      ? { 'content-type': reply.raw.type, ...APP_HEADERS, ...reply.raw.headers }
      : { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...APP_HEADERS };
    response.writeHead(reply.status, { ...headers, ...close, 'content-length': Buffer.byteLength(data) });
    // Node sends no body for a HEAD reply, whatever is passed here.
    response.end(data);
  };
  const fail = (response: ServerResponse, status: number, error: string): void => send(response, { status, json: { error } });

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      // A same-origin request from a rebound name carries no Origin header, so the Host is checked first.
      if (!isAllowedHost(request.headers.host)) {
        return fail(response, 403, 'Host not allowed. The service answers 127.0.0.1, localhost and [::1] only.');
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const method = request.method === 'HEAD' ? 'GET' : request.method ?? 'GET';
      const { headers } = request;
      // A link followed from another page is a top-level navigation; the app shell holds no data, so it may load.
      const opensApp = method === 'GET' && headers['sec-fetch-mode'] === 'navigate' && headers['sec-fetch-dest'] === 'document'
        && !compiled.some(({ route, pattern }) => route !== appRoute && route.method === method && pattern.test(url.pathname));
      const site = headers['sec-fetch-site'];
      // A browser no-cors GET or <img> carries no Origin but does say which site sent it; curl and Node send neither.
      if (!isAllowedBridgeOrigin(headers.origin) || (!headers.origin && !opensApp && (site === 'cross-site' || site === 'same-site'))) {
        return fail(response, 403, 'Origin not allowed. The service is local-only.');
      }
      // Sessions and ops are for MCP processes on this machine; no page, whatever its origin, gets in.
      if (url.pathname.startsWith('/sessions') && (headers.origin !== undefined || site !== undefined)) {
        return fail(response, 403, 'Sessions are for local agents, not web pages.');
      }
      let pathMatched = false;
      for (const { route, pattern, names } of compiled) {
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        // The app fallback matches every path, so it says nothing about whether the path is known.
        if (route !== appRoute) pathMatched = true;
        if (route.method !== method) continue;
        // Only JSON is accepted, so a cross-origin write needs a preflight, which no CORS header will pass.
        if (BODY_METHODS.has(method) && !/^application\/json\b/i.test(headers['content-type'] ?? '')) {
          return fail(response, 415, 'The request body must be application/json.');
        }
        const params = new Map<string, string>();
        try {
          names.forEach((name, i) => params.set(name, decodeURIComponent(match[i + 1] ?? '')));
        } catch {
          return fail(response, 400, 'The path is not valid.');
        }
        let body: Promise<unknown> | undefined;
        return send(response, await route.handle({ request, url, param: (name) => params.get(name) ?? '', deps, body: () => (body ??= readBody(request)) }), request.method === 'HEAD');
      }
      return fail(response, pathMatched ? 405 : 404, pathMatched ? `${method} is not allowed on ${url.pathname}.` : `No route for ${url.pathname}.`);
    } catch (error) {
      if (error instanceof HttpError) return fail(response, error.status, error.message);
      const message = error instanceof Error ? error.message : String(error);
      return fail(response, error instanceof NotFoundError ? 404 : error instanceof ConflictError ? 409 : 500, message);
    }
  };
}
