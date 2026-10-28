import { readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { BridgeThreadEvent } from '../src/lib/agent.js';
import { LiveBridge } from '../src/lib/bridge.js';
import { ServiceClient } from '../src/lib/serviceClient.js';
import { createServerWithDeps } from '../src/server.js';
import { NO_CHANNEL_NOTE } from '../src/tools/serviceTools.js';
import { startService, type RunningService } from '../src/service/serve.js';
import { tempConfig, tempDir } from './service/helpers.js';

// The MCP server as a client of a real service: started in-process on port 0, or spawned by the client itself.

const DSL = 'flowchart\n  A -> B';
const NAME = basename(process.cwd());

const services: RunningService[] = [];
const bridges: LiveBridge[] = [];
const clients: Client[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function boot(...projects: string[]) {
  const config = await tempConfig(...projects);
  const service = await startService({ port: 0, config, appDir: join(await tempDir(), 'no-app') });
  services.push(service);
  return { service, config };
}

/** One MCP server and its client, as one agent session would have them. */
async function session(url: string, options: { name?: string; channel?: boolean } = {}) {
  const bridge = new LiveBridge({ port: 0, log: () => undefined });
  bridges.push(bridge);
  const { server, service } = createServerWithDeps({ bridge, service: new ServiceClient({ url, clientName: () => options.name ?? 'claude-code', log: () => undefined }), log: () => undefined });
  closers.push(() => service.close());
  const client = new Client({ name: options.name ?? 'claude-code', version: '0.0.0' }, { capabilities: options.channel ? { experimental: { 'claude/channel': {} } } : {} });
  const notices: { content: string; meta: Record<string, string> }[] = [];
  const waiting: (() => void)[] = [];
  client.fallbackNotificationHandler = async (notice) => {
    if (notice.method !== 'notifications/claude/channel') return;
    notices.push(notice.params as never);
    waiting.splice(0).forEach((wake) => wake());
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: result.isError === true, texts: result.content.map(({ text }) => text), text: result.content[0]!.text };
  };
  const json = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    if (result.isError) throw new Error(result.text);
    return JSON.parse(result.text);
  };
  const nextNotice = async (): Promise<{ content: string; meta: Record<string, string> }> => {
    while (!notices.length) await new Promise<void>((wake) => waiting.push(wake));
    return notices.shift()!;
  };
  return { call, json, service, nextNotice };
}

describe('create_diagram in a project', () => {
  it('writes the file, returns the link and connects the creator (AC-3)', async () => {
    const { service, config } = await boot('alpha', 'beta');
    const agent = await session(service.url);
    const made = await agent.json('create_diagram', { project: 'alpha', diagramName: 'Checkout', dsl: DSL });
    expect(made.url).toMatch(/\/#\/p\/alpha\/[^/]+$/);
    expect(made.url.endsWith(`/#/p/alpha/${made.diagram}`)).toBe(true);
    expect(made.output).toMatchObject({ nodes: 2, connectors: 1 });
    expect(await readdir(config.projects[0]!.path)).toEqual(['checkout.openflow.json']);
    const who = await agent.json('whoami');
    expect(who.service).toMatchObject({ running: true, bindings: [{ project: 'alpha', id: made.diagram, title: 'Checkout' }] });
    expect(who.service.label).toBe(`claude-code · ${NAME}`);
  });

  it('refuses without a project when there are several, naming them; uses the only one otherwise (AC-3)', async () => {
    const several = await boot('alpha', 'beta');
    const agent = await session(several.service.url);
    const refused = await agent.call('create_diagram', { dsl: DSL });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('alpha');
    expect(refused.text).toContain('beta');
    expect((await agent.json('whoami')).service.bindings).toEqual([]);

    const one = await boot('solo');
    const other = await session(one.service.url);
    const made = await other.json('create_diagram', { dsl: DSL });
    expect(made.url).toContain('/#/p/solo/');
  });

  it('names the projects when asked for an unknown one', async () => {
    const { service } = await boot('alpha');
    const refused = await (await session(service.url)).call('create_diagram', { project: 'nope', dsl: DSL });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toMatch(/no project "nope"[\s\S]*alpha/);
  });
});

describe('connections', () => {
  it('refuses a diagram another session holds, naming its holder; one session may hold two; disconnect releases (AC-6)', async () => {
    const { service } = await boot('alpha');
    const first = await session(service.url, { name: 'Claude Code' });
    const second = await session(service.url, { name: 'Cursor' });
    const a = await first.json('create_diagram', { project: 'alpha', diagramName: 'One', dsl: DSL });
    const b = await first.json('create_diagram', { project: 'alpha', diagramName: 'Two', dsl: DSL });
    expect((await first.json('whoami')).service.bindings.map((x: { id: string }) => x.id).sort()).toEqual([a.diagram, b.diagram].sort());

    const refused = await second.call('connect_diagram', { project: 'alpha', diagram: a.diagram });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`Claude Code · ${NAME}`);

    await first.json('disconnect_diagram', { diagram: a.diagram });
    expect((await first.json('whoami')).service.bindings.map((x: { id: string }) => x.id)).toEqual([b.diagram]);
    expect(await second.json('connect_diagram', { project: 'alpha', diagram: a.diagram })).toMatchObject({ connected: { id: a.diagram } });
    expect((await second.json('whoami')).service.bindings.map((x: { id: string }) => x.id)).toEqual([a.diagram]);
  });

  it('disconnect_diagram without arguments needs exactly one connection', async () => {
    const { service } = await boot('alpha');
    const agent = await session(service.url);
    expect((await agent.call('disconnect_diagram')).text).toMatch(/not connected to a diagram/);
    const a = await agent.json('create_diagram', { project: 'alpha', dsl: DSL });
    await agent.json('create_diagram', { project: 'alpha', dsl: DSL });
    expect((await agent.call('disconnect_diagram')).text).toMatch(/2 diagrams/);
    await agent.json('disconnect_diagram', { project: 'alpha', diagram: a.diagram });
  });

  it('forgets a connection the app took away', async () => {
    const { service } = await boot('alpha');
    const agent = await session(service.url);
    const made = await agent.json('create_diagram', { project: 'alpha', dsl: DSL });
    const response = await fetch(`${service.url}/projects/alpha/diagrams/${made.diagram}/holder`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect((await agent.json('whoami')).service.bindings).toEqual([]);
  });
});

describe('which diagram a drawing tool lands on', () => {
  it('uses the only connection; with two it refuses and lists them; with none it refuses and changes nothing (AC-7, D5)', async () => {
    const { service, config } = await boot('alpha');
    const agent = await session(service.url);
    const folder = config.projects[0]!.path;

    const none = await agent.call('update_diagram', { diagram: 'ghost', frameId: 'f', dsl: DSL });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('not connected');
    expect((await agent.call('list_pages', {})).isError).toBe(true);
    expect(await readdir(folder)).toEqual([]);
    expect((await agent.json('whoami')).service.bindings).toEqual([]);

    const first = await agent.json('create_diagram', { project: 'alpha', diagramName: 'First', dsl: DSL });
    const second = await agent.json('create_diagram', { project: 'alpha', diagramName: 'Second', dsl: DSL });
    const refused = await agent.call('list_pages', {});
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(first.diagram);
    expect(refused.text).toContain(second.diagram);

    await agent.json('disconnect_diagram', { diagram: first.diagram });
    const pages = await agent.json('list_pages', {});
    expect(JSON.stringify(pages)).toContain(second.diagram);
  });

  it('draws on the connected diagram when no project is named', async () => {
    const { service } = await boot('alpha');
    const agent = await session(service.url);
    const made = await agent.json('create_diagram', { project: 'alpha', dsl: DSL });
    const again = await agent.json('create_diagram', { dsl: 'flowchart\n  C -> D' });
    expect(again.diagram).toBe(made.diagram);
    expect((await agent.json('list_diagrams')).output.diagrams).toHaveLength(2);
  });

  it('lists the service projects with their holders', async () => {
    const { service } = await boot('alpha', 'beta');
    const agent = await session(service.url);
    const made = await agent.json('create_diagram', { project: 'beta', diagramName: 'Held', dsl: DSL });
    const listed = await agent.json('list_diagrams');
    expect(listed.projects).toEqual([
      { name: 'alpha', path: expect.any(String), diagrams: [] },
      { name: 'beta', path: expect.any(String), diagrams: [expect.objectContaining({ id: made.diagram, holder: { label: `claude-code · ${NAME}` } })] },
    ]);
  });

  it('lists the projects before anything is connected', async () => {
    const { service } = await boot('alpha');
    const listed = await (await session(service.url)).json('list_diagrams');
    expect(listed.projects.map((p: { name: string }) => p.name)).toEqual(['alpha']);
  });

  it('leaves file mode alone when a documentId is given, even with a connection', async () => {
    const { service } = await boot('alpha');
    const agent = await session(service.url);
    await agent.json('create_diagram', { project: 'alpha', dsl: DSL });
    const { id: documentId } = await agent.json('openflow_create', { name: 'Local' });
    const drawn = await agent.json('create_diagram', { documentId, dsl: DSL });
    expect(drawn.documentId).toBe(documentId);
    expect(drawn.project).toBeUndefined();
  });

  it('does not touch the service for a session that never used it', async () => {
    const down = new ServiceClient({ url: 'http://127.0.0.1:1', clientName: () => 'x', log: () => undefined });
    expect(await down.bindings()).toEqual([]);
    expect(down.registered).toBe(false);
  });
});

describe('the restart sentence (AC-5)', () => {
  it('ends a drawing result when the session has no channel, and is absent when it has one', async () => {
    const { service } = await boot('alpha');
    const quiet = await session(service.url);
    const without = await quiet.call('create_diagram', { project: 'alpha', dsl: DSL });
    expect(without.texts.at(-1)).toBe(NO_CHANNEL_NOTE);
    expect((await quiet.call('create_diagram', { dsl: DSL })).texts.at(-1)).toBe(NO_CHANNEL_NOTE);

    const listening = await session(service.url, { name: 'Other', channel: true });
    const withIt = await listening.call('create_diagram', { project: 'alpha', dsl: DSL });
    expect(withIt.texts).not.toContain(NO_CHANNEL_NOTE);
    expect(JSON.parse(withIt.text)).toMatchObject({ project: 'alpha' });
  });
});

describe('comments from the canvas (AC-9)', () => {
  it('arrive as a channel notification with the same meta the bridge sends', async () => {
    const { service } = await boot('alpha');
    const agent = await session(service.url, { channel: true });
    const made = await agent.json('create_diagram', { project: 'alpha', dsl: DSL });
    const event: BridgeThreadEvent = {
      type: 'thread', documentId: made.diagram, pageId: 'p1', threadId: 't1', threadNumber: 3, commentId: 'm1',
      nodeId: 'n1', nodeLabel: 'API', kind: 'new_thread', author: 'Ana', body: 'Why is this synchronous?',
    };
    const posted = await fetch(`${service.url}/projects/alpha/diagrams/${made.diagram}/comments`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
    });
    expect(posted.status).toBe(202);
    const notice = await agent.nextNotice();
    expect(notice.content).toBe('Why is this synchronous?');
    expect(notice.meta).toEqual({
      document_id: made.diagram, page_id: 'p1', thread_id: 't1', thread_number: '3', comment_id: 'm1',
      node_id: 'n1', node_label: 'API', kind: 'new_thread', author: 'Ana',
    });
  });
});

describe('a port held by something else (R-5)', () => {
  let other: Server | null = null;
  afterEach(() => new Promise<void>((done) => { if (other) { other.closeAllConnections(); other.close(() => done()); } else done(); }));

  it.each([
    ['JSON that is not the service', JSON.stringify({ service: 'something-else' }), 'application/json'],
    ['a web page', '<html>hello</html>', 'text/html'],
  ])('ensure() names the port and the config key when it answers %s', async (_label, body, type) => {
    other = createServer((_request, response) => { response.writeHead(200, { 'content-type': type }); response.end(body); });
    await new Promise<void>((ready) => other!.listen(0, '127.0.0.1', ready));
    const port = (other.address() as { port: number }).port;
    const client = new ServiceClient({ url: `http://127.0.0.1:${port}`, clientName: () => 'x', log: () => undefined });
    await expect(client.ensure()).rejects.toThrow(new RegExp(`Port ${port} is in use[\\s\\S]*"port"[\\s\\S]*OPENFLOWKIT_SERVICE_URL`));
  });
});

describe('starting the service (AC-4, D10)', () => {
  const saved = { config: process.env.OPENFLOWKIT_SERVICE_CONFIG, home: process.env.HOME };
  let url = '';
  afterEach(async () => {
    if (saved.config === undefined) delete process.env.OPENFLOWKIT_SERVICE_CONFIG; else process.env.OPENFLOWKIT_SERVICE_CONFIG = saved.config;
    process.env.HOME = saved.home;
    // Whatever the test got to, the service it started must not outlive the run.
    const running = url ? await fetch(`${url}/health`).then((reply) => reply.json() as Promise<{ pid: number }>).catch(() => null) : null;
    if (running) process.kill(running.pid);
    url = '';
  });

  it('spawns serve on the first call, keeps it after the server closes, and a second server finds it', async () => {
    // A free port, then a config that names it: the spawned process reads both from this environment.
    const probe = createServer();
    await new Promise<void>((ready) => probe.listen(0, '127.0.0.1', ready));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    const home = await tempDir();
    const projects = await tempConfig('alpha');
    const { writeFile } = await import('node:fs/promises');
    const file = join(home, 'service.json');
    await writeFile(file, JSON.stringify({ port, projects: projects.projects }));
    process.env.OPENFLOWKIT_SERVICE_CONFIG = file;
    process.env.HOME = home;
    url = `http://127.0.0.1:${port}`;
    const health = async () => (await (await fetch(`${url}/health`)).json()) as { pid: number };

    const first = await session(url);
    const started = Date.now();
    const made = await first.json('create_diagram', { project: 'alpha', dsl: DSL });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(made.url).toBe(`${url}/#/p/alpha/${made.diagram}`);
    const pid = (await health()).pid;
    expect(pid).not.toBe(process.pid);

    // The MCP server goes away; the service is the user's and stays.
    closers.splice(0).forEach((close) => close());
    await Promise.all(clients.splice(0).map((client) => client.close()));
    expect(() => process.kill(pid, 0)).not.toThrow();

    const second = await session(url, { name: 'Cursor' });
    await second.json('create_diagram', { project: 'alpha', dsl: DSL });
    expect((await health()).pid).toBe(pid);
  }, 30_000);
});
