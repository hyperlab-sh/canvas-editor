import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createEvents } from '../../src/service/events.js';
import { createHandler } from '../../src/service/routes.js';
import { createSessions } from '../../src/service/sessions.js';
import { createStore } from '../../src/service/store.js';
import { tempConfig } from './helpers.js';
import { bind, boot, call, closeServicesAfterEach, newDiagram, register } from './sessionHelpers.js';

closeServicesAfterEach();

describe('sessions', () => {
  it('registers a session labelled by client and working directory basename', async () => {
    const { service } = await boot();
    const reply = await call(service, 'POST', '/sessions', { client: 'Claude Code', cwd: '/x/hyper', pid: 7 });
    expect(reply.status).toBe(201);
    expect(reply.json).toEqual({ sessionId: expect.any(String), label: 'Claude Code · hyper' });
  });

  it('tells two sessions with one label apart by process id', async () => {
    const { service } = await boot();
    const first = await register(service, 'Claude Code', '/a/hyper', 11);
    const second = await register(service, 'Claude Code', '/b/hyper', 22);
    expect(first.label).toBe('Claude Code · hyper');
    expect(second.label).toBe('Claude Code · hyper (22)');
  });

  it('refuses a registration without a cwd or pid', async () => {
    const { service } = await boot();
    expect((await call(service, 'POST', '/sessions', { client: 'c', pid: 1 })).status).toBe(400);
    expect((await call(service, 'POST', '/sessions', { client: 'c', cwd: '/x', pid: 'one' })).status).toBe(400);
  });

  it('refuses a registration that carries an Origin header (C-11)', async () => {
    const { service } = await boot();
    const reply = await call(service, 'POST', '/sessions', { client: 'c', cwd: '/x', pid: 1 }, { origin: 'http://localhost:3000' });
    expect(reply.status).toBe(403);
    const ops = await call(service, 'POST', '/sessions/abc/ops', { project: 'alpha', id: 'x', op: 'move' }, { origin: 'http://localhost:3000' });
    expect(ops.status).toBe(403);
  });

  it('binds one diagram to one session and refuses another with the holder label (D13)', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const first = await register(service, 'Claude Code', '/x/hyper', 1);
    const second = await register(service, 'Codex', '/y/other', 2);
    const bound = await bind(service, first.sessionId, id);
    expect(bound.status).toBe(200);
    expect(bound.json).toMatchObject({ diagram: { project: 'alpha', id, title: 'Flow' } });
    const refused = await bind(service, second.sessionId, id);
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ holder: 'Claude Code · hyper' });
    // The holder binding again changes nothing.
    expect((await bind(service, first.sessionId, id)).status).toBe(200);
  });

  it('lets one session bind two diagrams', async () => {
    const { service } = await boot();
    const a = await newDiagram(service, 'A');
    const b = await newDiagram(service, 'B');
    const session = await register(service);
    expect((await bind(service, session.sessionId, a.id)).status).toBe(200);
    expect((await bind(service, session.sessionId, b.id)).status).toBe(200);
    const listing = (await call(service, 'GET', '/projects')).json;
    const holders = listing[0].diagrams.map((d: { holder: unknown }) => d.holder);
    expect(holders).toEqual([{ label: session.label }, { label: session.label }]);
  });

  it('answers 404 for an unknown diagram and an unknown session', async () => {
    const { service } = await boot();
    const session = await register(service);
    expect((await bind(service, session.sessionId, 'nope')).status).toBe(404);
    expect((await bind(service, 'ghost', 'nope')).status).toBe(404);
  });

  it('shows the holder in the diagram reply and frees it on unbind', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const session = await register(service);
    await bind(service, session.sessionId, id);
    expect((await call(service, 'GET', `/projects/alpha/diagrams/${id}`)).json.holder).toEqual({ label: session.label });
    const unbound = await call(service, 'DELETE', `/sessions/${session.sessionId}/bindings/alpha/${id}`);
    expect(unbound.status).toBe(204);
    expect((await call(service, 'GET', `/projects/alpha/diagrams/${id}`)).json.holder).toBeNull();
    // Another session may take it now.
    const other = await register(service, 'Codex', '/y/o', 3);
    expect((await bind(service, other.sessionId, id)).status).toBe(200);
  });

  it('does not let a session unbind a diagram another session holds', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const holder = await register(service, 'Claude Code', '/x/hyper', 1);
    const other = await register(service, 'Codex', '/y/o', 2);
    await bind(service, holder.sessionId, id);
    await call(service, 'DELETE', `/sessions/${other.sessionId}/bindings/alpha/${id}`);
    expect((await call(service, 'GET', `/projects/alpha/diagrams/${id}`)).json.holder).toEqual({ label: holder.label });
  });

  it('releases the bindings of a session whose poll is not renewed (AC-6)', async () => {
    const { service } = await boot({ ttlMs: 150, sweepMs: 20 });
    const { id } = await newDiagram(service);
    const session = await register(service);
    await bind(service, session.sessionId, id);
    await vi.waitFor(async () => {
      expect((await call(service, 'GET', `/projects/alpha/diagrams/${id}`)).json.holder).toBeNull();
    }, { timeout: 3000, interval: 25 });
    // The session is gone: it registers again.
    expect((await call(service, 'GET', `/sessions/${session.sessionId}/events?wait=0`)).status).toBe(404);
  });

  it('keeps a session alive while its poll is parked', async () => {
    const { service } = await boot({ ttlMs: 100, sweepMs: 20 });
    const { id } = await newDiagram(service);
    const session = await register(service);
    await bind(service, session.sessionId, id);
    // The poll outlives the ttl several times over; it returns 204 on its own timeout.
    const poll = await call(service, 'GET', `/sessions/${session.sessionId}/events?wait=1`);
    expect(poll.status).toBe(204);
    expect((await call(service, 'GET', `/projects/alpha/diagrams/${id}`)).json.holder).toEqual({ label: session.label });
  });

  it('answers 404 "Register again" when the session is swept while the bind awaits the diagram', async () => {
    const config = await tempConfig('alpha');
    const real = createStore(config);
    const { id } = await real.create('alpha', 'Flow');
    const sessions = createSessions();
    const events = createEvents(real, sessions);
    const { sessionId } = sessions.register({ client: 'Claude Code', cwd: '/x/hyper', pid: 1 });
    // The sweeper drops the session during the diagram read, after the route checked it.
    const store = { ...real, read: async (project: string, doc: string) => { const read = await real.read(project, doc); sessions.release(sessionId); return read; } };
    const server = createServer(createHandler({ config, store, sessions, events, appDir: '/nonexistent', port: () => 0 }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'alpha', id }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: `Unknown session ${sessionId}. Register again.` });
    } finally {
      events.close();
      sessions.close();
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  });

  it('keeps sweeping when a release listener throws', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sessions = createSessions({ ttlMs: 30, sweepMs: 10 });
    sessions.onRelease(() => { throw new Error('listener failed'); });
    const first = sessions.register({ client: 'a', cwd: '/x/a', pid: 1 });
    const second = sessions.register({ client: 'b', cwd: '/x/b', pid: 2 });
    try {
      await vi.waitFor(() => {
        expect(sessions.get(first.sessionId)).toBeUndefined();
        expect(sessions.get(second.sessionId)).toBeUndefined();
      }, { timeout: 3000, interval: 10 });
      expect(quiet).toHaveBeenCalled();
    } finally {
      sessions.close();
      quiet.mockRestore();
    }
  });
});
