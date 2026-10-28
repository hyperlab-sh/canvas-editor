import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentDocument } from '../../src/lib/agent.js';
import { DocumentStore } from '../../src/lib/documentStore.js';
import { listDiagrams } from '../../src/service/projects.js';
import { createStore } from '../../src/service/store.js';
import { putFile, tempConfig } from './helpers.js';

async function seeded(name = 'Seed') {
  const config = await tempConfig('a');
  const folder = config.projects[0].path;
  const doc = createAgentDocument(name);
  const file = join(folder, 'seed.openflow.json');
  await putFile(file, doc);
  return { config, folder, doc, file, store: createStore(config) };
}

describe('store.write', () => {
  it('writes the same bytes as DocumentStore.save', async () => {
    const { config, folder, doc, store } = await seeded();
    const edited = { ...doc, name: 'Edited ✓', metadata: { k: [1, 2, { z: null }] } };
    const { revision } = await store.read('a', doc.id);
    expect(await store.write('a', doc.id, edited, revision)).toMatchObject({ status: 'ok' });
    const legacy = new DocumentStore();
    legacy.set(edited);
    const legacyPath = join(folder, '..', 'legacy.json');
    await legacy.save(doc.id, legacyPath);
    expect(await readFile(join(folder, 'seed.openflow.json'), 'utf8')).toBe(await readFile(legacyPath, 'utf8'));
    expect(config.projects).toHaveLength(1);
  });

  it('increments the revision, emits changed, and read returns the new document', async () => {
    const { doc, store } = await seeded();
    const events: [string, string, number][] = [];
    const off = store.changed((p, i, r) => events.push([p, i, r]));
    const first = await store.read('a', doc.id);
    const result = await store.write('a', doc.id, { ...doc, name: 'Two' }, first.revision);
    expect(result).toEqual({ status: 'ok', revision: first.revision + 1 });
    expect((await store.read('a', doc.id)).document.name).toBe('Two');
    expect(events).toEqual([['a', doc.id, first.revision + 1]]);
    off();
    await store.write('a', doc.id, { ...doc, name: 'Three' }, first.revision + 1);
    expect(events).toHaveLength(1);
  });

  it('returns stale with the current document and leaves the file untouched', async () => {
    const { doc, file, store } = await seeded();
    const { revision } = await store.read('a', doc.id);
    await store.write('a', doc.id, { ...doc, name: 'Winner' }, revision);
    const onDisk = await readFile(file, 'utf8');
    const result = await store.write('a', doc.id, { ...doc, name: 'Loser' }, revision);
    expect(result).toMatchObject({ status: 'stale', revision: revision + 1 });
    expect(result.status === 'stale' && result.document.name).toBe('Winner');
    expect(await readFile(file, 'utf8')).toBe(onDisk);
  });

  it('lets exactly one of two concurrent writes with the same revision win', async () => {
    const { doc, store } = await seeded();
    const { revision } = await store.read('a', doc.id);
    const results = await Promise.all([
      store.write('a', doc.id, { ...doc, name: 'One' }, revision),
      store.write('a', doc.id, { ...doc, name: 'Two' }, revision),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['ok', 'stale']);
  });

  it('refuses a document whose id differs from the diagram', async () => {
    const { doc, file, store } = await seeded();
    const before = await readFile(file, 'utf8');
    await expect(store.write('a', doc.id, { ...doc, id: 'other' }, 0)).rejects.toThrow('does not match diagram');
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});

describe('store.create', () => {
  it('writes <slug>.openflow.json and suffixes -2, -3 on collision', async () => {
    const config = await tempConfig('a');
    const store = createStore(config);
    const one = await store.create('a', 'My Flow!');
    const two = await store.create('a', 'My Flow!');
    const three = await store.create('a', 'My Flow!');
    expect((await readdir(config.projects[0].path)).sort()).toEqual(['my-flow-2.openflow.json', 'my-flow-3.openflow.json', 'my-flow.openflow.json']);
    expect(new Set([one.id, two.id, three.id]).size).toBe(3);
    expect(JSON.parse(await readFile(join(config.projects[0].path, 'my-flow-2.openflow.json'), 'utf8')).id).toBe(two.id);
  });

  it('falls back to "diagram" for a name with no letters, and emits changed', async () => {
    const config = await tempConfig('a');
    const store = createStore(config);
    const seen: string[] = [];
    store.changed((p, id) => seen.push(`${p}/${id}`));
    const made = await store.create('a', '???');
    expect(await readdir(config.projects[0].path)).toEqual(['diagram.openflow.json']);
    expect(seen).toEqual([`a/${made.id}`]);
  });

  it('creates a diagram that is listed and readable at its revision', async () => {
    const config = await tempConfig('a');
    const store = createStore(config);
    const made = await store.create('a', 'Listed');
    expect((await listDiagrams(config))[0].diagrams).toMatchObject([{ id: made.id, title: 'Listed' }]);
    expect(await store.read('a', made.id)).toMatchObject({ revision: made.revision, document: { id: made.id } });
  });

  it('refuses an unknown project', async () => {
    const store = createStore(await tempConfig('a'));
    await expect(store.create('nope', 'X')).rejects.toThrow('Unknown project "nope"');
  });
});

describe('store.read', () => {
  it('reads a file the CLI saved (format compatibility)', async () => {
    const config = await tempConfig('a');
    const legacy = new DocumentStore();
    const doc = legacy.create('From CLI');
    await legacy.save(doc.id, join(config.projects[0].path, 'cli.openflow.json'));
    expect((await createStore(config).read('a', doc.id)).document.name).toBe('From CLI');
  });

  it('refuses a file that is not a document', async () => {
    const config = await tempConfig('a');
    await writeFile(join(config.projects[0].path, 'bad.openflow.json'), JSON.stringify({ id: 'bad', name: 'x' }));
    await expect(createStore(config).read('a', 'bad')).rejects.toThrow();
  });
});
