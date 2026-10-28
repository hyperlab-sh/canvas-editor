// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V2DocumentInvalidError, V2StorageError, V2StorageUnavailableError } from '../v2/v2Errors';
import { createServiceRepository } from './serviceRepository';

interface RunningService { readonly url: string; close(): Promise<void> }
// Loaded by path, not import: the root project does not type-check the service's sources.
const SERVICE_SOURCE = join(process.cwd(), 'mcp-server/src/service/serve.ts');
const startService = async (options: unknown): Promise<RunningService> =>
  ((await import(/* @vite-ignore */ SERVICE_SOURCE)) as { startService(options: unknown): Promise<RunningService> }).startService(options);

let root: string;
let service: RunningService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ofk-repo-'));
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
});
