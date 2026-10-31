// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V2DocumentInvalidError, V2StorageError, V2StorageUnavailableError } from '../v2/v2Errors';
import { createServiceRepository, renameServiceDiagram } from './serviceRepository';

interface RunningService { readonly url: string; close(): Promise<void> }
// Loaded by path, not import: the root project does not type-check the service's sources.
const SERVICE_SOURCE = join(process.cwd(), 'mcp-server/src/service/serve.ts');
const startService = async (options: unknown): Promise<RunningService> =>
  ((await import(/* @vite-ignore */ SERVICE_SOURCE)) as { startService(options: unknown): Promise<RunningService> }).startService(options);

let root: string;
let service: RunningService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'canvas-repo-'));
  await mkdir(join(root, 'alpha'));
  await mkdir(join(root, 'beta'));
  service = await startService({
    port: 0, appDir: join(root, 'no-app'),
    config: { port: 0, projects: [{ name: 'alpha', path: join(root, 'alpha') }, { name: 'beta', path: join(root, 'beta') }] },
  });
});
afterEach(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});

const post = async (path: string, body: unknown) =>
  (await fetch(`${service.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{ id: string; revision: number }>;

describe('createServiceRepository', () => {
  it('loads a diagram of the project', async () => {
    const { id } = await post('/projects/alpha/diagrams', { name: 'Flow' });
    const result = await createServiceRepository('alpha', service.url).loadDocument(id);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.record.id).toBe(id);
    expect(result.record.document.name).toBe('Flow');
    expect(result.record.revision).toBeGreaterThan(0);
  });

  it('reports a diagram the service does not have as missing', async () => {
    expect(await createServiceRepository('alpha', service.url).loadDocument('nope')).toEqual({ status: 'missing' });
    expect(await createServiceRepository('ghost', service.url).loadDocument('nope')).toEqual({ status: 'missing' });
  });

  it('saves with the editor’s own revision numbers, several times over', async () => {
    const { id } = await post('/projects/alpha/diagrams', { name: 'Flow' });
    const repository = createServiceRepository('alpha', service.url);
    const loaded = await repository.loadDocument(id);
    if (loaded.status !== 'ok') throw new Error('did not open');
    const base = loaded.record.revision;
    // The editor counts edits, the service counts writes: three edits in one debounce make revision base+3 from one write.
    const first = await repository.saveDocument(id, { ...loaded.record.document, name: 'One' }, base + 3, base);
    expect(first.status).toBe('saved');
    const second = await repository.saveDocument(id, { ...loaded.record.document, name: 'Two' }, base + 4, base + 3);
    expect(second.status).toBe('saved');
    const again = await repository.loadDocument(id);
    expect(again.status === 'ok' && again.record.document.name).toBe('Two');
  });

  it('answers stale, with the stored revision, when another writer got there first', async () => {
    const { id } = await post('/projects/alpha/diagrams', { name: 'Flow' });
    const repository = createServiceRepository('alpha', service.url);
    const loaded = await repository.loadDocument(id);
    if (loaded.status !== 'ok') throw new Error('did not open');
    const base = loaded.record.revision;
    const other = await fetch(`${service.url}/projects/alpha/diagrams/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: { ...loaded.record.document, name: 'Theirs' }, revision: base }),
    });
    const { revision: theirs } = await other.json() as { revision: number };
    const result = await repository.saveDocument(id, { ...loaded.record.document, name: 'Mine' }, base + 1, base);
    expect(result).toEqual({ status: 'stale', storedRevision: theirs });
    const stored = await repository.loadDocument(id);
    expect(stored.status === 'ok' && stored.record.document.name).toBe('Theirs');
  });

  it('will not guess which service revision an unpaired save replaces', async () => {
    const { id } = await post('/projects/alpha/diagrams', { name: 'Flow' });
    const fresh = createServiceRepository('alpha', service.url);
    const loaded = await createServiceRepository('alpha', service.url).loadDocument(id);
    if (loaded.status !== 'ok') throw new Error('did not open');
    const { revision } = loaded.record;
    await expect(fresh.saveDocument(id, loaded.record.document, revision + 1, revision)).rejects.toThrow(/Open the diagram again/);
    // Paired by a load, a save at a revision the load did not give is refused the same way.
    await fresh.loadDocument(id);
    await expect(fresh.saveDocument(id, loaded.record.document, revision + 5, revision + 4)).rejects.toThrow(/Open the diagram again/);
  });

  it('renames a diagram through the service', async () => {
    const { id } = await post('/projects/alpha/diagrams', { name: 'Flow' });
    await renameServiceDiagram('alpha', id, 'Renamed', service.url);
    const loaded = await createServiceRepository('alpha', service.url).loadDocument(id);
    expect(loaded.status === 'ok' && loaded.record.document.name).toBe('Renamed');
  });

  it('refuses to rename a diagram the service does not have, in the service’s words', async () => {
    await expect(renameServiceDiagram('alpha', 'nope', 'X', service.url)).rejects.toThrow(/could not rename the diagram: .+/);
    await expect(renameServiceDiagram('alpha', 'nope', 'X', service.url)).rejects.toThrow(V2StorageError);
  });

  it('says the service is not reachable when a rename finds a closed port', async () => {
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    await expect(renameServiceDiagram('alpha', 'x', 'X', `http://127.0.0.1:${closed}`)).rejects.toThrow(V2StorageUnavailableError);
    await expect(renameServiceDiagram('alpha', 'x', 'X', `http://127.0.0.1:${closed}`)).rejects.toThrow(/not reachable/);
  });

  it('reports a hand-edited file the service cannot read, in the service’s words', async () => {
    const { id } = await post('/projects/alpha/diagrams', { name: 'Flow' });
    const file = join(root, 'alpha', 'flow.openflow.json');
    const original = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const repository = createServiceRepository('alpha', service.url);
    await writeFile(file, JSON.stringify({ ...original, schemaVersion: 999 }));
    await expect(repository.loadDocument(id)).rejects.toThrow(/Unsupported schema version/);
    await writeFile(file, JSON.stringify({ ...original, pages: 'nope' }));
    await expect(repository.loadDocument(id)).rejects.toThrow(V2StorageError);
  });

  it('refuses a document the service will not store, in the service’s words', async () => {
    const { id } = await post('/projects/alpha/diagrams', { name: 'Flow' });
    const repository = createServiceRepository('alpha', service.url);
    const loaded = await repository.loadDocument(id);
    if (loaded.status !== 'ok') throw new Error('did not open');
    const wrongId = { ...loaded.record.document, id: 'someone-else' };
    await expect(repository.saveDocument(id, wrongId, loaded.record.revision + 1, loaded.record.revision)).rejects.toThrow(V2DocumentInvalidError);
    await expect(repository.saveDocument(id, wrongId, loaded.record.revision + 1, loaded.record.revision)).rejects.toThrow(/does not match/);
  });

  it('lists every project’s diagrams with their project, newest first', async () => {
    await post('/projects/alpha/diagrams', { name: 'First' });
    await post('/projects/beta/diagrams', { name: 'Second' });
    const list = await createServiceRepository('alpha', service.url).listDocuments();
    expect(list.map((d) => [d.project, d.name]).sort()).toEqual([['alpha', 'First'], ['beta', 'Second']]);
    expect(list.every((d) => d.id && d.savedAt)).toBe(true);
    expect([...list].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))).toEqual(list);
  });

  it('keeps no thumbnails and no archive', async () => {
    const repository = createServiceRepository('alpha', service.url);
    await repository.saveThumbnail('x', { light: '<svg/>', dark: '<svg/>' });
    expect((await repository.listThumbnails()).size).toBe(0);
    expect(await repository.listArchive()).toEqual([]);
    await expect(repository.deleteDocument('x')).rejects.toThrow(V2StorageError);
    await expect(repository.archiveDocuments(['x'])).rejects.toThrow(/not available/);
  });

  it('says the service is unreachable when nothing listens', async () => {
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    const repository = createServiceRepository('alpha', `http://127.0.0.1:${closed}`);
    await expect(repository.loadDocument('x')).rejects.toThrow(V2StorageUnavailableError);
    await expect(repository.listDocuments()).rejects.toThrow(/not reachable/);
  });
  describe('comments and the holder', () => {
    const EVENT = {
      type: 'thread', documentId: '', pageId: 'p', threadId: 't', threadNumber: 1, commentId: 'm', nodeId: null, nodeLabel: null,
      kind: 'new_thread', author: 'Ana', body: 'hi',
    } as const;
    const holdBy = async (id: string, channel?: boolean) => {
      const { sessionId } = await (await fetch(`${service.url}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client: 'Claude Code', cwd: root, pid: process.pid, ...(channel === undefined ? {} : { channel }) }) })).json() as { sessionId: string };
      await fetch(`${service.url}/sessions/${sessionId}/bindings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'alpha', id }) });
      return sessionId;
    };

    it('delivers a comment to the holder, and says false when nobody holds the diagram', async () => {
      const { id } = await post('/projects/alpha/diagrams', { name: 'Flow' });
      const repository = createServiceRepository('alpha', service.url);
      expect(await repository.postComment(id, { ...EVENT, documentId: id })).toBe(false);
      const sessionId = await holdBy(id);
      expect(await repository.postComment(id, { ...EVENT, documentId: id })).toBe(true);
      const parked = await (await fetch(`${service.url}/sessions/${sessionId}/events?wait=1`)).json() as { events: { commentId: string }[] };
      expect(parked.events.map((event) => event.commentId)).toEqual(['m']);
    });

    it('disconnect releases the holder', async () => {
      const { id } = await post('/projects/alpha/diagrams', { name: 'Flow' });
      const repository = createServiceRepository('alpha', service.url);
      await holdBy(id);
      expect((await repository.fetchCurrent(id)).holder).toEqual({ label: expect.stringMatching(/^Claude Code · /), channel: false });
      await repository.disconnect(id);
      expect((await repository.fetchCurrent(id)).holder).toBeNull();
    });

    it('says whether the holder hears comments', async () => {
      const { id } = await post('/projects/alpha/diagrams', { name: 'Flow' });
      const repository = createServiceRepository('alpha', service.url);
      await holdBy(id, true);
      expect((await repository.fetchCurrent(id)).holder).toMatchObject({ channel: true });
    });

    it('a comment for another diagram is refused loudly, not read as "nobody holds it"', async () => {
      const { id } = await post('/projects/alpha/diagrams', { name: 'Flow' });
      await expect(createServiceRepository('alpha', service.url).postComment(id, { ...EVENT, documentId: 'other' })).rejects.toBeInstanceOf(V2StorageError);
    });
  });
});
