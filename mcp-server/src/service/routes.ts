import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { isAllowedBridgeOrigin, parseAgentDocument } from '../lib/agent.js';
import { MCP_SERVER_VERSION } from '../lib/version.js';
import type { ServiceConfig } from './config.js';
import { listDiagrams } from './projects.js';
import type { Store } from './store.js';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface ServiceDeps {
  readonly config: ServiceConfig;
  readonly store: Store;
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

const NOT_FOUND = /^(Unknown project|No diagram) /;

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
  const file = join(appDir, relative);
  // `..` segments are normalised away above, but a path that still leaves the app folder gets the app, not the file.
  if (file !== appDir && file.startsWith(appDir + sep) && (await stat(file).catch(() => null))?.isFile()) {
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
          // holder is filled in by the sessions unit; until then nothing holds a diagram.
          json: listing.map(({ name, diagrams }) => ({
            name,
            path: deps.config.projects.find((p) => p.name === name)?.path,
            diagrams: diagrams.map((d) => ({ ...d, holder: null })),
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
        // holder is filled in by the sessions unit.
        return { status: 200, json: { document, revision, holder: null } };
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
        // A write that lost the race to another save is re-read and retried once, so a rename never overwrites the winner.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await store.read(p, id);
          const result = await store.write(p, id, { ...current.document, name: name.trim() }, current.revision);
          if (result.status === 'ok') return { status: 200, json: { revision: result.revision } };
        }
        throw new HttpError(409, 'The diagram kept changing; try the rename again.');
      },
    },
  ];
}

/** Answers every GET the API did not: the app, with `index.html` for the hash router. Always last. */
export const appRoute: Route = { method: 'GET', path: '/*', handle: serveApp };

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

  const send = (response: ServerResponse, reply: RouteReply): void => {
    if (reply.raw) {
      response.writeHead(reply.status, { 'content-type': reply.raw.type, ...APP_HEADERS, ...reply.raw.headers });
      response.end(reply.raw.data);
      return;
    }
    response.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...APP_HEADERS });
    response.end(JSON.stringify(reply.json ?? null));
  };
  const fail = (response: ServerResponse, status: number, error: string): void => send(response, { status, json: { error } });

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      // A same-origin request from a rebound name carries no Origin header, so the Host is checked first.
      if (!isAllowedHost(request.headers.host)) {
        return fail(response, 403, 'Host not allowed. The service answers 127.0.0.1, localhost and [::1] only.');
      }
      const { origin } = request.headers;
      const site = request.headers['sec-fetch-site'];
      // A browser no-cors GET or <img> carries no Origin but does say which site sent it; curl and Node send neither.
      if (!isAllowedBridgeOrigin(origin) || (!origin && (site === 'cross-site' || site === 'same-site'))) {
        return fail(response, 403, 'Origin not allowed. The service is local-only.');
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const method = request.method ?? 'GET';
      let pathMatched = false;
      for (const { route, pattern, names } of compiled) {
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        // The app fallback matches every path, so it says nothing about whether the path is known.
        if (route !== appRoute) pathMatched = true;
        if (route.method !== method) continue;
        const params = new Map<string, string>();
        try {
          names.forEach((name, i) => params.set(name, decodeURIComponent(match[i + 1] ?? '')));
        } catch {
          return fail(response, 400, 'The path is not valid.');
        }
        let body: Promise<unknown> | undefined;
        return send(response, await route.handle({ request, url, param: (name) => params.get(name) ?? '', deps, body: () => (body ??= readBody(request)) }));
      }
      return fail(response, pathMatched ? 405 : 404, pathMatched ? `${method} is not allowed on ${url.pathname}.` : `No route for ${url.pathname}.`);
    } catch (error) {
      if (error instanceof HttpError) return fail(response, error.status, error.message);
      const message = error instanceof Error ? error.message : String(error);
      return fail(response, NOT_FOUND.test(message) ? 404 : 500, message);
    }
  };
}
