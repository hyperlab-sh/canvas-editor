import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentDocument } from '../../src/lib/agent.js';
import { listDiagrams, resolveDiagram } from '../../src/service/projects.js';
import { putFile, tempConfig } from './helpers.js';

describe('listDiagrams', () => {
  it('lists *.openflow.json one level deep with id, title and modifiedAt', async () => {
    const config = await tempConfig('a', 'b');
    const path = config.projects[0].path;
    const doc = createAgentDocument('First');
    await putFile(join(path, 'first.openflow.json'), doc);
    await putFile(join(path, 'ignored.json'), createAgentDocument('Other'));
    await putFile(join(path, 'notes.openflow.json.bak'), createAgentDocument('Bak'));
    await mkdir(join(path, 'deep'));
    await putFile(join(path, 'deep', 'nested.openflow.json'), createAgentDocument('Nested'));
    await writeFile(join(path, 'broken.openflow.json'), '{nope');
    await utimes(join(path, 'first.openflow.json'), new Date('2024-01-02T03:04:05Z'), new Date('2024-01-02T03:04:05Z'));
    const [a, b] = await listDiagrams(config);
    expect(a).toEqual({ name: 'a', path, diagrams: [{ id: doc.id, title: 'First', modifiedAt: '2024-01-02T03:04:05.000Z' }] });
    expect(b.diagrams).toEqual([]);
  });

  it('shows a title edited on disk in the next listing, and a file added by hand', async () => {
    const config = await tempConfig('a');
    const file = join(config.projects[0].path, 'd.openflow.json');
    const doc = createAgentDocument('Old');
    await putFile(file, doc);
    expect((await listDiagrams(config))[0].diagrams[0].title).toBe('Old');
    // Same size, so only the mtime tells the cache the file changed.
    await putFile(file, { ...doc, name: 'New' });
    await utimes(file, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
    expect((await listDiagrams(config))[0].diagrams[0]).toMatchObject({ title: 'New', modifiedAt: '2030-01-01T00:00:00.000Z' });
    await putFile(join(config.projects[0].path, 'e.openflow.json'), createAgentDocument('Added'));
    expect((await listDiagrams(config))[0].diagrams.map((d) => d.title).sort()).toEqual(['Added', 'New']);
  });

  it('serves the cached head while (path, mtime, size) are unchanged', async () => {
    const config = await tempConfig('a');
    const file = join(config.projects[0].path, 'd.openflow.json');
    const doc = createAgentDocument('AAA');
    await putFile(file, doc);
    const mtime = new Date('2024-05-05T05:05:05Z');
    await utimes(file, mtime, mtime);
    await listDiagrams(config);
    // Same size and mtime: the content is not re-read.
    await putFile(file, { ...doc, name: 'BBB' });
    await utimes(file, mtime, mtime);
    expect((await listDiagrams(config))[0].diagrams[0].title).toBe('AAA');
  });

  it('lists only the first file of a duplicate id', async () => {
    const config = await tempConfig('a');
    const doc = createAgentDocument('Dup');
    await putFile(join(config.projects[0].path, 'a.openflow.json'), doc);
    await putFile(join(config.projects[0].path, 'b.openflow.json'), { ...doc, name: 'Second' });
    expect((await listDiagrams(config))[0].diagrams).toHaveLength(1);
    expect((await listDiagrams(config))[0].diagrams[0].title).toBe('Dup');
  });
});

describe('resolveDiagram', () => {
  it('maps (project, id) to its file', async () => {
    const config = await tempConfig('a');
    const doc = createAgentDocument('X');
    await putFile(join(config.projects[0].path, 'x.openflow.json'), doc);
    expect(await resolveDiagram(config, 'a', doc.id)).toEqual({ project: 'a', id: doc.id, path: join(config.projects[0].path, 'x.openflow.json') });
  });

  it('refuses a duplicate id naming both files', async () => {
    const config = await tempConfig('a');
    const doc = createAgentDocument('Dup');
    await putFile(join(config.projects[0].path, 'one.openflow.json'), doc);
    await putFile(join(config.projects[0].path, 'two.openflow.json'), doc);
    await expect(resolveDiagram(config, 'a', doc.id)).rejects.toThrow(/one\.openflow\.json and two\.openflow\.json/);
  });

  it('refuses an unknown project and an unknown id', async () => {
    const config = await tempConfig('a');
    await expect(resolveDiagram(config, 'zzz', 'x')).rejects.toThrow('Unknown project "zzz". Configured: a.');
    await expect(resolveDiagram(config, 'a', 'x')).rejects.toThrow('No diagram "x" in project "a"');
  });
});
