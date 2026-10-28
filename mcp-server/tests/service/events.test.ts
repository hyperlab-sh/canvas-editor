import { copyFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStore } from '../../src/service/store.js';
import { tempConfig } from './helpers.js';
import { bind, boot, call, closeServicesAfterEach, newDiagram, openStream, register, serveWith } from './sessionHelpers.js';

closeServicesAfterEach();

const threadEvent = (documentId: string, body = 'Make it blue') => ({
  type: 'thread', documentId, pageId: 'p1', threadId: 't1', threadNumber: 1, commentId: 'c1',
  nodeId: null, nodeLabel: null, kind: 'new_thread', author: 'Ana', body,
});

describe('GET /events', () => {
  it('needs a project and an id', async () => {
    const { service } = await boot();
    expect((await call(service, 'GET', '/events?project=alpha')).status).toBe(400);
  });

  it('sends revision when the diagram is saved, to its tabs only', async () => {
    const { service } = await boot();
    const a = await newDiagram(service, 'A');
    const b = await newDiagram(service, 'B');
    const streamA = await openStream(service, a.id);
    const streamB = await openStream(service, b.id);
    expect(streamA.status).toBe(200);
    const doc = (await call(service, 'GET', `/projects/alpha/diagrams/${a.id}`)).json;
    const put = await call(service, 'PUT', `/projects/alpha/diagrams/${a.id}`, { document: doc.document, revision: doc.revision });
    expect(await streamA.next('revision')).toEqual({ project: 'alpha', id: a.id, revision: put.json.revision });
    // B saw nothing: its first event is the one written after A's.
    const docB = (await call(service, 'GET', `/projects/alpha/diagrams/${b.id}`)).json;
    const putB = await call(service, 'PUT', `/projects/alpha/diagrams/${b.id}`, { document: docB.document, revision: docB.revision });
    expect(await streamB.next('revision')).toMatchObject({ id: b.id, revision: putB.json.revision });
    streamA.close();
    streamB.close();
  });

  it('sends holder on connect and on release (AC-10)', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const session = await register(service);
    const stream = await openStream(service, id);
    await bind(service, session.sessionId, id);
    expect(await stream.next('holder')).toEqual({ project: 'alpha', id, label: session.label, channel: false });
    const released = await call(service, 'DELETE', `/projects/alpha/diagrams/${id}/holder`);
    expect(released.status).toBe(204);
    expect(await stream.next('holder')).toEqual({ project: 'alpha', id, label: null, channel: false });
    stream.close();
  });

  it('tells the tabs whether the holder hears comments: the channel it registered with', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const { sessionId, label } = (await call(service, 'POST', '/sessions', { client: 'Claude Code', cwd: '/x/hyper', pid: 7, channel: true })).json;
    const stream = await openStream(service, id);
    await bind(service, sessionId, id);
    expect(await stream.next('holder')).toEqual({ project: 'alpha', id, label, channel: true });
    expect((await call(service, 'GET', `/projects/alpha/diagrams/${id}`)).json.holder).toEqual({ label, channel: true });
    // Anything but true is no channel, including what an older MCP server sends (nothing).
    const mute = (await call(service, 'POST', '/sessions', { client: 'Codex', cwd: '/y/o', pid: 8, channel: 'yes' })).json;
    const { id: other } = await newDiagram(service, 'Other');
    await bind(service, mute.sessionId, other);
    expect((await call(service, 'GET', `/projects/alpha/diagrams/${other}`)).json.holder).toEqual({ label: mute.label, channel: false });
    stream.close();
  });
});

describe('POST …/comments and GET /sessions/:id/events', () => {
  it('delivers a thread event to the holder\'s parked poll and to no other session (AC-9)', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const holder = await register(service, 'Claude Code', '/x/hyper', 1);
    const other = await register(service, 'Codex', '/y/o', 2);
    await bind(service, holder.sessionId, id);
    const parked = call(service, 'GET', `/sessions/${holder.sessionId}/events?wait=10`);
    const bystander = call(service, 'GET', `/sessions/${other.sessionId}/events?wait=1`);
    const posted = await call(service, 'POST', `/projects/alpha/diagrams/${id}/comments`, threadEvent(id));
    expect(posted.status).toBe(202);
    const got = await parked;
    expect(got.status).toBe(200);
    expect(got.json).toEqual({ events: [threadEvent(id)] });
    expect((await bystander).status).toBe(204);
  });

  it('queues an event for a holder that is not polling and hands it over in order', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const holder = await register(service);
    await bind(service, holder.sessionId, id);
    await call(service, 'POST', `/projects/alpha/diagrams/${id}/comments`, threadEvent(id, 'one'));
    await call(service, 'POST', `/projects/alpha/diagrams/${id}/comments`, threadEvent(id, 'two'));
    const got = await call(service, 'GET', `/sessions/${holder.sessionId}/events?wait=0`);
    expect(got.json.events.map((e: { body: string }) => e.body)).toEqual(['one', 'two']);
    expect((await call(service, 'GET', `/sessions/${holder.sessionId}/events?wait=0`)).status).toBe(204);
  });

  it('answers 409 when no session holds the diagram', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const reply = await call(service, 'POST', `/projects/alpha/diagrams/${id}/comments`, threadEvent(id));
    expect(reply).toMatchObject({ status: 409, json: { error: 'No session holds this diagram' } });
  });

  it('refuses a body that is not a thread event or is for another document', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    expect((await call(service, 'POST', `/projects/alpha/diagrams/${id}/comments`, { type: 'thread' })).status).toBe(400);
    expect((await call(service, 'POST', `/projects/alpha/diagrams/${id}/comments`, threadEvent('other'))).status).toBe(400);
  });

  it('answers 404 to a poll from an unknown session', async () => {
    const { service } = await boot();
    expect((await call(service, 'GET', '/sessions/ghost/events?wait=0')).status).toBe(404);
  });

  it('drops events queued for a diagram when it is disconnected', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const holder = await register(service);
    await bind(service, holder.sessionId, id);
    await call(service, 'POST', `/projects/alpha/diagrams/${id}/comments`, threadEvent(id));
    await call(service, 'DELETE', `/projects/alpha/diagrams/${id}/holder`);
    await bind(service, holder.sessionId, id);
    expect((await call(service, 'GET', `/sessions/${holder.sessionId}/events?wait=0`)).status).toBe(204);
  });

  it('gives a released session\'s queued comments to nobody', async () => {
    const config = await tempConfig('alpha');
    const store = createStore(config);
    const { id } = await store.create('alpha', 'Flow');
    const live = await serveWith(config, store);
    try {
      const old = (await call(live, 'POST', '/sessions', { client: 'Claude Code', cwd: '/x/hyper', pid: 1 })).json.sessionId;
      await bind(live, old, id);
      await call(live, 'POST', `/projects/alpha/diagrams/${id}/comments`, threadEvent(id));
      live.sessions.release(old);
      expect((await call(live, 'GET', `/sessions/${old}/events?wait=0`)).status).toBe(404);
      const next = (await call(live, 'POST', '/sessions', { client: 'Codex', cwd: '/y/o', pid: 2 })).json.sessionId;
      expect((await bind(live, next, id)).status).toBe(200);
      expect((await call(live, 'GET', `/sessions/${next}/events?wait=0`)).status).toBe(204);
    } finally {
      await live.close();
    }
  });
});

const head = (port: number, path: string) => new Promise<number>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'HEAD' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
  req.on('error', reject);
  req.end();
});

describe('HEAD', () => {

  it('answers at once on the tab stream and the session poll instead of parking', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const session = await register(service);
    expect(await head(service.port, `/events?project=alpha&id=${id}`)).toBe(200);
    expect(await head(service.port, `/sessions/${session.sessionId}/events?wait=25`)).toBe(204);
  });

  it('does not take queued events: HEAD reports them and a later GET still delivers them', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const holder = await register(service);
    await bind(service, holder.sessionId, id);
    await call(service, 'POST', `/projects/alpha/diagrams/${id}/comments`, threadEvent(id));
    expect(await head(service.port, `/sessions/${holder.sessionId}/events?wait=25`)).toBe(200);
    const got = await call(service, 'GET', `/sessions/${holder.sessionId}/events?wait=0`);
    expect(got.json).toEqual({ events: [threadEvent(id)] });
    expect(await head(service.port, `/sessions/${holder.sessionId}/events`)).toBe(204);
  });
});

describe('queued events across projects', () => {
  it('drops only the disconnected project\'s events when two projects share a diagram id', async () => {
    const config = await tempConfig('alpha', 'beta');
    const store = createStore(config);
    const { id } = await store.create('alpha', 'Flow');
    // A copied file: the same diagram id in a second project.
    await copyFile(join(config.projects[0]!.path, 'flow.openflow.json'), join(config.projects[1]!.path, 'flow.openflow.json'));
    const live = await serveWith(config, store);
    try {
      const sid = (await call(live, 'POST', '/sessions', { client: 'Claude Code', cwd: '/x/hyper', pid: 1 })).json.sessionId;
      for (const project of ['alpha', 'beta']) {
        expect((await call(live, 'POST', `/sessions/${sid}/bindings`, { project, id })).status).toBe(200);
        expect((await call(live, 'POST', `/projects/${project}/diagrams/${id}/comments`, threadEvent(id, `for ${project}`))).status).toBe(202);
      }
      expect((await call(live, 'DELETE', `/projects/alpha/diagrams/${id}/holder`)).status).toBe(204);
      const got = await call(live, 'GET', `/sessions/${sid}/events?wait=0`);
      expect(got.json.events.map((event: { body: string }) => event.body)).toEqual(['for beta']);
    } finally {
      await live.close();
    }
  });
});
