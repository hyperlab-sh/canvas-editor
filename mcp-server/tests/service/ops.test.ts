import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSessions, type Sessions } from '../../src/service/sessions.js';
import { createStore, type Store } from '../../src/service/store.js';
import { tempConfig } from './helpers.js';
import { bind, boot, call, closeServicesAfterEach, newDiagram, openStream, register, serveWith } from './sessionHelpers.js';

closeServicesAfterEach();

const DRAW = { project: 'alpha', op: 'create_diagram', input: { dsl: 'flowchart\n  A -> B\n' } };

async function onDisk(folder: string): Promise<string> {
  return readFile(join(folder, 'flow.openflow.json'), 'utf8');
}

describe('POST /sessions/:id/ops', () => {
  it('runs the op on a bound diagram, writes the file and tells the tab (AC-7)', async () => {
    const { service, folder } = await boot();
    const { id } = await newDiagram(service);
    const session = await register(service);
    await bind(service, session.sessionId, id);
    const stream = await openStream(service, id);
    const before = await onDisk(folder);

    const reply = await call(service, 'POST', `/sessions/${session.sessionId}/ops`, { ...DRAW, id });
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ ok: true, output: { nodes: 2, connectors: 1 } });

    const event = await stream.next('revision', 2000) as { project: string; id: string; revision: number };
    expect(event).toMatchObject({ project: 'alpha', id });
    const written = await onDisk(folder);
    expect(written).not.toBe(before);
    expect(JSON.parse(written).pages[0].nodes.length).toBeGreaterThanOrEqual(2);
    const read = await call(service, 'GET', `/projects/alpha/diagrams/${id}`);
    expect(read.json.revision).toBe(event.revision);
    stream.close();
  });

  it('refuses a session that is not bound to the diagram and leaves the file alone (D5)', async () => {
    const { service, folder } = await boot();
    const { id } = await newDiagram(service);
    const session = await register(service);
    const before = await onDisk(folder);
    const reply = await call(service, 'POST', `/sessions/${session.sessionId}/ops`, { ...DRAW, id });
    expect(reply.status).toBe(409);
    expect(reply.json).toMatchObject({ ok: false, error: expect.stringContaining('not connected'), holder: null });
    expect(await onDisk(folder)).toBe(before);
  });

  it('names the holder when another session has the diagram', async () => {
    const { service, folder } = await boot();
    const { id } = await newDiagram(service);
    const holder = await register(service, 'Claude Code', '/x/hyper', 1);
    const other = await register(service, 'Codex', '/y/o', 2);
    await bind(service, holder.sessionId, id);
    const before = await onDisk(folder);
    const reply = await call(service, 'POST', `/sessions/${other.sessionId}/ops`, { ...DRAW, id });
    expect(reply.status).toBe(409);
    expect(reply.json).toMatchObject({ ok: false, holder: 'Claude Code · hyper' });
    expect(reply.json.error).toContain('Claude Code · hyper');
    expect(await onDisk(folder)).toBe(before);
  });

  it('reports an unknown op, invalid input and an unknown session', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const session = await register(service);
    await bind(service, session.sessionId, id);
    const path = `/sessions/${session.sessionId}/ops`;
    const unknown = await call(service, 'POST', path, { project: 'alpha', id, op: 'no_such_op', input: {} });
    expect(unknown).toMatchObject({ status: 400, json: { ok: false, error: 'Unknown op "no_such_op".' } });
    const invalid = await call(service, 'POST', path, { project: 'alpha', id, op: 'create_diagram', input: { dsl: 5 } });
    expect(invalid.status).toBe(400);
    expect(invalid.json.ok).toBe(false);
    expect((await call(service, 'POST', '/sessions/ghost/ops', { ...DRAW, id })).status).toBe(404);
    expect((await call(service, 'POST', path, { project: 'alpha' })).status).toBe(400);
  });

  it('runs a read-only op without writing or announcing a revision', async () => {
    const { service, folder } = await boot();
    const { id } = await newDiagram(service);
    const session = await register(service);
    await bind(service, session.sessionId, id);
    const before = await onDisk(folder);
    const reply = await call(service, 'POST', `/sessions/${session.sessionId}/ops`, { project: 'alpha', id, op: 'list_pages', input: {} });
    expect(reply.status).toBe(200);
    expect(reply.json.ok).toBe(true);
    expect(await onDisk(folder)).toBe(before);
  });

  it('stops an op after the session is released (AC-10 follow-up)', async () => {
    const { service } = await boot();
    const { id } = await newDiagram(service);
    const session = await register(service);
    await bind(service, session.sessionId, id);
    await call(service, 'DELETE', `/projects/alpha/diagrams/${id}/holder`);
    const reply = await call(service, 'POST', `/sessions/${session.sessionId}/ops`, { ...DRAW, id });
    expect(reply.status).toBe(409);
  });

  /** A service over `store` with one diagram and a registered, bound session; runs `act`, then closes. */
  async function withBoundSession(wrap: (real: Store, sessions: Sessions) => Store, act: (ctx: { url: string; sessionId: string; id: string; real: Store }) => Promise<void>): Promise<void> {
    const config = await tempConfig('alpha');
    const real = createStore(config);
    const { id } = await real.create('alpha', 'Flow');
    const sessions = createSessions();
    const live = await serveWith(config, { ...real, ...wrap(real, sessions) }, sessions);
    try {
      const { sessionId } = (await call(live, 'POST', '/sessions', { client: 'Claude Code', cwd: '/x/hyper', pid: 1 })).json;
      expect((await bind(live, sessionId, id)).status).toBe(200);
      await act({ url: live.url, sessionId, id, real });
    } finally {
      await live.close();
    }
  }

  const drawVia = (url: string, sessionId: string, id: string) => call({ url }, 'POST', `/sessions/${sessionId}/ops`, { ...DRAW, id });

  it('redoes an op on the newer document when a tab saved first, keeping both edits', async () => {
    // The tab's save lands between the op's read and its write, once.
    let raced = false;
    await withBoundSession((real) => ({
      write: async (project, doc, document, expected) => {
        if (!raced) {
          raced = true;
          const tab = await real.read(project, doc);
          await real.write(project, doc, { ...tab.document, name: 'Renamed by tab' }, tab.revision);
        }
        return real.write(project, doc, document, expected);
      },
    }), async ({ url, sessionId, id, real }) => {
      const reply = await drawVia(url, sessionId, id);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ ok: true });
      const { document } = await real.read('alpha', id);
      expect(document.name).toBe('Renamed by tab');
      expect(JSON.stringify(document)).toContain('"A"');
    });
  });

  it('gives up with 409 and leaves the file when every write is stale', async () => {
    let writes = 0;
    await withBoundSession((real) => ({
      write: async (project, doc) => {
        writes += 1;
        return { status: 'stale', revision: 9, document: (await real.read(project, doc)).document };
      },
    }), async ({ url, sessionId, id, real }) => {
      const before = await real.read('alpha', id);
      const reply = await drawVia(url, sessionId, id);
      expect(reply.status).toBe(409);
      expect(reply.json).toEqual({ ok: false, error: 'The diagram kept changing under the op; try it again.' });
      expect(writes).toBe(3);
      expect((await real.read('alpha', id)).document).toEqual(before.document);
    });
  });

  it('does not write when the diagram is disconnected while the op runs', async () => {
    // The app's Disconnect arrives while the op is reading the document.
    let armed = false;
    await withBoundSession((real, sessions) => ({
      read: async (project, doc) => {
        const read = await real.read(project, doc);
        if (armed) sessions.disconnect(project, doc);
        return read;
      },
    }), async ({ url, sessionId, id, real }) => {
      const before = await real.read('alpha', id);
      armed = true;
      const reply = await drawVia(url, sessionId, id);
      expect(reply.status).toBe(409);
      expect(reply.json).toMatchObject({ ok: false, holder: null });
      expect((await real.read('alpha', id)).document).toEqual(before.document);
    });
  });
});
