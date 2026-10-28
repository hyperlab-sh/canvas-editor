import { createServer, request } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentDocument } from '../../src/lib/agent.js';
import { MCP_SERVER_VERSION } from '../../src/lib/version.js';
import { startService, type RunningService } from '../../src/service/serve.js';
import { createHandler, type Route } from '../../src/service/routes.js';
import { createEvents } from '../../src/service/events.js';
import { createSessions } from '../../src/service/sessions.js';
import { createStore } from '../../src/service/store.js';
import { putFile, tempConfig, tempDir } from './helpers.js';

const running: RunningService[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((service) => service.close()));
});

/** A real service on port 0 over a temp config; returns it with its project folders. */
async function boot(options: { appDir?: string; routes?: readonly Route[]; projects?: string[] } = {}) {
  const config = await tempConfig(...(options.projects ?? ['alpha', 'beta']));
  const root = await tempDir();
  const service = await startService({ port: 0, config, appDir: options.appDir ?? join(root, 'no-app'), ...(options.routes ? { routes: options.routes } : {}) });
  running.push(service);
  return { service, config, folder: (name: string) => config.projects.find((p) => p.name === name)!.path, root };
}

async function call(service: RunningService, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${service.url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  // Replies are asserted by shape in each test; a typed model per route would repeat the routes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, text, json, headers: response.headers };
}

/** fetch forbids overriding Host; node:http does not. */
function withHost(service: RunningService, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: service.port, path: '/health', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** node:http sends the Sec-Fetch-* headers as given; fetch rewrites sec-fetch-mode and -dest itself. */
function rawGet(service: RunningService, path: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: service.port, path, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /health', () => {
  it('names the service, version, bound port, projects and pid', async () => {
    const { service } = await boot();
    const { status, json } = await call(service, 'GET', '/health');
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, service: 'openflowkit-service', version: MCP_SERVER_VERSION, port: service.port, projects: ['alpha', 'beta'], pid: process.pid });
    expect(service.port).toBeGreaterThan(0);
  });
});

describe('GET /projects', () => {
  it('lists every project and shows a file added by hand in the next call', async () => {
    const { service, folder } = await boot();
    const first = await call(service, 'GET', '/projects');
    expect(first.json.map((p: { name: string; path: string; diagrams: unknown[] }) => [p.name, p.path, p.diagrams])).toEqual([['alpha', folder('alpha'), []], ['beta', folder('beta'), []]]);
    const doc = createAgentDocument('By hand');
    await putFile(join(folder('beta'), 'hand.openflow.json'), doc);
    const second = await call(service, 'GET', '/projects');
    expect(second.json[1].diagrams).toEqual([{ id: doc.id, title: 'By hand', modifiedAt: expect.any(String), holder: null }]);
  });
});

describe('diagram routes', () => {
  it('creates a diagram file and returns id, project, url and revision', async () => {
    const { service, folder } = await boot();
    const { status, json } = await call(service, 'POST', '/projects/alpha/diagrams', { name: 'My Flow' });
    expect(status).toBe(201);
    expect(json).toEqual({ id: expect.any(String), project: 'alpha', url: `http://127.0.0.1:${service.port}/#/p/alpha/${json.id}`, revision: expect.any(Number) });
    const onDisk = JSON.parse(await readFile(join(folder('alpha'), 'my-flow.openflow.json'), 'utf8'));
    expect(onDisk).toMatchObject({ id: json.id, name: 'My Flow' });
    const read = await call(service, 'GET', `/projects/alpha/diagrams/${json.id}`);
    expect(read.json).toEqual({ document: onDisk, revision: json.revision, holder: null });
  });

  it('refuses a create without a name, with invalid JSON, and in an unknown project', async () => {
    const { service } = await boot();
    expect(await call(service, 'POST', '/projects/alpha/diagrams', {})).toMatchObject({ status: 400, json: { error: 'Creating a diagram needs a "name".' } });
    const bad = await fetch(`${service.url}/projects/alpha/diagrams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'The request body is not valid JSON.' });
    const none = await call(service, 'POST', '/projects/nope/diagrams', { name: 'x' });
    expect(none.status).toBe(404);
    expect(none.json.error).toBe('Unknown project "nope". Configured: alpha, beta.');
  });

  it('answers 404 for an unknown diagram', async () => {
    const { service } = await boot();
    const { status, json } = await call(service, 'GET', '/projects/alpha/diagrams/missing');
    expect(status).toBe(404);
    expect(json.error).toBe('No diagram "missing" in project "alpha".');
  });

  it('PUT with the current revision saves and returns the next; a stale one is 409 and leaves the file unchanged', async () => {
    const { service, folder } = await boot();
    const created = (await call(service, 'POST', '/projects/alpha/diagrams', { name: 'Flow' })).json;
    const path = join(folder('alpha'), 'flow.openflow.json');
    const { document, revision } = (await call(service, 'GET', `/projects/alpha/diagrams/${created.id}`)).json;

    const saved = await call(service, 'PUT', `/projects/alpha/diagrams/${created.id}`, { document: { ...document, name: 'First' }, revision });
    expect(saved).toMatchObject({ status: 200, json: { revision: revision + 1 } });
    const afterFirst = await readFile(path, 'utf8');
    expect(JSON.parse(afterFirst).name).toBe('First');

    const stale = await call(service, 'PUT', `/projects/alpha/diagrams/${created.id}`, { document: { ...document, name: 'Second' }, revision });
    expect(stale.status).toBe(409);
    expect(stale.json.revision).toBe(revision + 1);
    expect(stale.json.document.name).toBe('First');
    expect(await readFile(path, 'utf8')).toBe(afterFirst);
  });

  it('PUT refuses a missing revision, a document that is not a diagram, and an id that differs from the URL', async () => {
    const { service } = await boot();
    const created = (await call(service, 'POST', '/projects/alpha/diagrams', { name: 'Flow' })).json;
    const { document, revision } = (await call(service, 'GET', `/projects/alpha/diagrams/${created.id}`)).json;
    const url = `/projects/alpha/diagrams/${created.id}`;
    expect(await call(service, 'PUT', url, { document })).toMatchObject({ status: 400, json: { error: 'Saving needs the "revision" you last loaded.' } });
    expect((await call(service, 'PUT', url, { document: { nope: true }, revision })).status).toBe(400);
    const other = await call(service, 'PUT', url, { document: { ...document, id: 'other' }, revision });
    expect(other.status).toBe(400);
    expect(other.json.error).toBe(`Document id "other" does not match diagram "${created.id}".`);
  });

  it('PATCH renames the diagram and bumps the revision', async () => {
    const { service } = await boot();
    const created = (await call(service, 'POST', '/projects/alpha/diagrams', { name: 'Flow' })).json;
    const url = `/projects/alpha/diagrams/${created.id}`;
    const renamed = await call(service, 'PATCH', url, { name: '  Better  ' });
    expect(renamed).toMatchObject({ status: 200, json: { revision: created.revision + 1 } });
    const read = (await call(service, 'GET', url)).json;
    expect(read.document.name).toBe('Better');
    expect(read.revision).toBe(created.revision + 1);
    expect(await call(service, 'PATCH', url, {})).toMatchObject({ status: 400, json: { error: 'Renaming needs a "name".' } });
  });

  it('answers 405 on a known path with the wrong method and 404 on an unknown API path', async () => {
    const { service } = await boot();
    expect(await call(service, 'DELETE', '/health')).toMatchObject({ status: 405, json: { error: 'DELETE is not allowed on /health.' } });
    expect(await call(service, 'POST', '/nothing/here', {})).toMatchObject({ status: 404, json: { error: 'No route for /nothing/here.' } });
  });
});

describe('the app', () => {
  async function appDir() {
    const dir = join(await tempDir(), 'app');
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<html>app</html>');
    await writeFile(join(dir, 'assets', 'x.js'), 'console.log(1)');
    await writeFile(join(dir, '..', 'secret.txt'), 'secret');
    return dir;
  }

  it('serves index.html, the asset, and index.html for any unknown path', async () => {
    const { service } = await boot({ appDir: await appDir() });
    expect(await call(service, 'GET', '/')).toMatchObject({ status: 200, text: '<html>app</html>' });
    const asset = await call(service, 'GET', '/assets/x.js');
    expect(asset).toMatchObject({ status: 200, text: 'console.log(1)' });
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(await call(service, 'GET', '/p/alpha/whatever')).toMatchObject({ status: 200, text: '<html>app</html>' });
  });

  it('never serves a file outside the app folder', async () => {
    const { service } = await boot({ appDir: await appDir() });
    const raw = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: service.port, path: '/../secret.txt', method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end();
    });
    expect(raw).toBe('<html>app</html>');
    expect((await call(service, 'GET', '/%2e%2e/secret.txt')).text).toBe('<html>app</html>');
    // URL parsing keeps an encoded slash, so only normalising the decoded path stops this one.
    expect((await call(service, 'GET', '/..%2fsecret.txt')).text).toBe('<html>app</html>');
  });

  it('answers 503 naming the path looked at when the app is missing', async () => {
    const { service, root } = await boot();
    const { status, text } = await call(service, 'GET', '/');
    expect(status).toBe(503);
    expect(text).toContain(join(root, 'no-app', 'index.html'));
  });
});

describe('Host and Origin checks', () => {
  it('refuses a foreign Host and answers localhost, 127.0.0.1 and [::1] with any port', async () => {
    const { service } = await boot();
    const refused = await withHost(service, 'evil.example');
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body).error).toBe('Host not allowed. The service answers 127.0.0.1, localhost and [::1] only.');
    expect((await withHost(service, 'evil.example:80')).status).toBe(403);
    for (const host of ['localhost:9000', '127.0.0.1', '[::1]:3000']) expect((await withHost(service, host)).status).toBe(200);
  });

  it('refuses a foreign Origin on every method, and a cross-site request without one', async () => {
    const { service } = await boot();
    for (const method of ['GET', 'POST', 'PUT', 'OPTIONS']) {
      const res = await call(service, method, '/projects', undefined, { origin: 'https://evil.example' });
      expect(res.status, method).toBe(403);
      expect(res.json.error).toBe('Origin not allowed. The service is local-only.');
    }
    expect((await call(service, 'GET', '/projects', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call(service, 'GET', '/projects', undefined, { origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await call(service, 'GET', '/projects', undefined, { origin: `http://127.0.0.1:${service.port}`, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });
});

describe('the route table', () => {
  it('takes extra rows with :params ahead of the app fallback', async () => {
    const extra: Route = {
      method: 'GET', path: '/extras/:id/events',
      handle: async ({ param, deps }) => ({ status: 200, json: { id: param('id'), projects: deps.config.projects.length } }),
    };
    const { service } = await boot({ routes: [extra] });
    expect((await call(service, 'GET', '/extras/a%20b/events')).json).toEqual({ id: 'a b', projects: 2 });
  });
});

describe('request failures', () => {
  const NAV = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

  it('lets a link from another page open the app but not read the API', async () => {
    const dir = join(await tempDir(), 'app');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), '<html>app</html>');
    const { service } = await boot({ appDir: dir });
    expect(await rawGet(service, '/', NAV)).toEqual({ status: 200, text: '<html>app</html>' });
    expect(await rawGet(service, '/p/alpha/x', { ...NAV, 'sec-fetch-site': 'same-site' })).toMatchObject({ status: 200 });
    expect(await rawGet(service, '/projects', NAV)).toEqual({ status: 403, text: '{"error":"Origin not allowed. The service is local-only."}' });
    // A subresource fetch of the app from another site is still refused.
    expect((await rawGet(service, '/assets/x.js', { ...NAV, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' })).status).toBe(403);
  });

  it('refuses a write that is not application/json, so a cross-origin page needs a preflight', async () => {
    const { service, folder } = await boot();
    for (const method of ['POST', 'PUT', 'PATCH']) {
      const url = method === 'POST' ? '/projects/alpha/diagrams' : '/projects/alpha/diagrams/x';
      const res = await fetch(`${service.url}${url}`, { method, headers: { 'content-type': 'text/plain', origin: 'http://localhost:5173' }, body: '{"name":"Evil"}' });
      expect(res.status, method).toBe(415);
      expect(await res.json()).toEqual({ error: 'The request body must be application/json.' });
    }
    const bare = await fetch(`${service.url}/projects/alpha/diagrams`, { method: 'POST', body: '{"name":"Evil"}', headers: { 'content-type': '' } });
    expect(bare.status).toBe(415);
    expect((await call(service, 'GET', '/projects')).json[0].diagrams).toEqual([]);
    expect(folder('alpha')).toBeTruthy();
  });

  it('answers 413 for a declared body over 32 MB without reading it', async () => {
    const { service } = await boot();
    const reply = await new Promise<{ status: number; connection: string | undefined; body: unknown }>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: service.port, path: '/projects/alpha/diagrams', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(33 * 1024 * 1024) },
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.write('{"name":"x"}');
    });
    expect(reply).toEqual({ status: 413, connection: 'close', body: { error: 'Request body too large.' } });
  });

  it('answers HEAD like GET without a body, so a link checker sees the app', async () => {
    const dir = join(await tempDir(), 'app');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), '<html>app</html>');
    const { service } = await boot({ appDir: dir });
    const head = async (path: string) => {
      const res = await fetch(`${service.url}${path}`, { method: 'HEAD' });
      return { status: res.status, length: res.headers.get('content-length'), text: await res.text() };
    };
    expect(await head('/')).toEqual({ status: 200, length: String('<html>app</html>'.length), text: '' });
    expect(await head('/health')).toMatchObject({ status: 200, text: '' });
    expect((await head('/projects/alpha/diagrams/missing')).status).toBe(404);
  });

  it('answers 400 for an undecodable path and for a body that is not an object', async () => {
    const { service } = await boot();
    expect(await call(service, 'GET', '/projects/alpha/diagrams/%E0%A4%A')).toMatchObject({ status: 400, json: { error: 'The path is not valid.' } });
    expect(await call(service, 'POST', '/projects/alpha/diagrams', [])).toMatchObject({ status: 400, json: { error: 'The request needs a JSON object body.' } });
    const empty = await fetch(`${service.url}/projects/alpha/diagrams`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'The request needs a JSON object body.' });
  });

  it('answers 404 for PUT and PATCH on an unknown diagram', async () => {
    const { service } = await boot();
    const document = createAgentDocument('X');
    const put = await call(service, 'PUT', '/projects/alpha/diagrams/missing', { document: { ...document, id: 'missing' }, revision: 1 });
    expect(put).toMatchObject({ status: 404, json: { error: 'No diagram "missing" in project "alpha".' } });
    expect(await call(service, 'PATCH', '/projects/alpha/diagrams/missing', { name: 'N' })).toMatchObject({ status: 404, json: { error: 'No diagram "missing" in project "alpha".' } });
    expect((await call(service, 'GET', '/projects/nope/diagrams/x')).status).toBe(404);
  });

  it('answers 409 when two files in a project carry one diagram id', async () => {
    const { service, folder } = await boot();
    const doc = createAgentDocument('Twin');
    await putFile(join(folder('alpha'), 'a.openflow.json'), doc);
    await putFile(join(folder('alpha'), 'b.openflow.json'), doc);
    const res = await call(service, 'GET', `/projects/alpha/diagrams/${doc.id}`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(`Diagram id "${doc.id}" appears in both a.openflow.json and b.openflow.json in project "alpha"; rename or remove one.`);
  });

  it('answers 409 when a rename keeps losing the race', async () => {
    const config = await tempConfig('alpha');
    const real = createStore(config);
    const { id } = await real.create('alpha', 'Busy');
    // A store whose every write finds a newer revision: the rename must give up, not overwrite.
    const sessions = createSessions();
    const store = { ...real, write: async (p: string, i: string) => ({ status: 'stale' as const, revision: 9, document: (await real.read(p, i)).document }) };
    const events = createEvents(store, sessions);
    const server = createServer(createHandler({ config, store, sessions, events, appDir: '/nonexistent', port: () => 0 }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/projects/alpha/diagrams/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"name":"N"}' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'The diagram kept changing; try the rename again.' });
    } finally {
      sessions.close();
      events.close();
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  });
});
