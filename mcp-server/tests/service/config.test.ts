import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/service/config.js';
import { tempDir } from './helpers.js';

let home: string;
const saved = { HOME: process.env.HOME, config: process.env.OPENFLOWKIT_SERVICE_CONFIG };

beforeEach(async () => {
  home = await tempDir();
  process.env.HOME = home;
  delete process.env.OPENFLOWKIT_SERVICE_CONFIG;
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  if (saved.config === undefined) delete process.env.OPENFLOWKIT_SERVICE_CONFIG;
  else process.env.OPENFLOWKIT_SERVICE_CONFIG = saved.config;
});

async function configWith(body: unknown): Promise<string> {
  const file = join(home, 'custom.json');
  await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
  process.env.OPENFLOWKIT_SERVICE_CONFIG = file;
  return file;
}

describe('loadConfig', () => {
  it('writes a default file with the scratch project when none exists', async () => {
    const config = await loadConfig();
    const scratch = join(home, '.local', 'share', 'openflowkit', 'diagrams');
    expect(config.port).toBe(43120);
    expect(config.projects).toEqual([{ name: 'scratch', path: scratch }]);
    const file = join(home, '.config', 'openflowkit', 'service.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ port: 43120, projects: [{ name: 'scratch', path: scratch }] });
  });

  it('leaves an existing file untouched and honours the env path override', async () => {
    const dir = join(home, 'a');
    await mkdir(dir);
    const file = await configWith({ port: 5000, projects: [{ name: 'a.b_c-1', path: dir }] });
    const before = await readFile(file, 'utf8');
    const config = await loadConfig();
    expect(config).toEqual({ port: 5000, projects: [{ name: 'a.b_c-1', path: dir }] });
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it.each(['Hyper', '-x', 'a b', 'a/b', ''])('refuses the invalid project name %j naming it', async (name) => {
    await configWith({ port: 1, projects: [{ name, path: home }] });
    await expect(loadConfig()).rejects.toThrow(`invalid project name ${JSON.stringify(name)}`);
  });

  it('refuses a duplicate project name', async () => {
    await configWith({ port: 1, projects: [{ name: 'a', path: home }, { name: 'a', path: home }] });
    await expect(loadConfig()).rejects.toThrow('project name "a" is listed twice');
  });

  it('refuses a path that is not a directory, or is missing, naming project and path', async () => {
    const file = join(home, 'file.txt');
    await writeFile(file, 'x');
    await configWith({ port: 1, projects: [{ name: 'f', path: file }] });
    await expect(loadConfig()).rejects.toThrow(`project "f" path ${file} is not a directory`);
    const missing = join(home, 'nope');
    await configWith({ port: 1, projects: [{ name: 'm', path: missing }] });
    await expect(loadConfig()).rejects.toThrow(`project "m" path ${missing} is not a directory`);
  });

  it('refuses two projects on the same folder naming both', async () => {
    await configWith({ port: 1, projects: [{ name: 'a', path: home }, { name: 'b', path: home }] });
    await expect(loadConfig()).rejects.toThrow(`project "b" path ${home} is already used by project "a"`);
  });

  it('refuses port 0 (the service needs a fixed port)', async () => {
    await configWith({ port: 0, projects: [] });
    await expect(loadConfig()).rejects.toThrow('"port" must be an integer from 1 to 65535');
  });

  it('refuses a relative path, a bad port, malformed JSON and a missing project list', async () => {
    await configWith({ port: 1, projects: [{ name: 'r', path: 'rel' }] });
    await expect(loadConfig()).rejects.toThrow('project "r" needs an absolute "path"');
    await configWith({ port: 'x', projects: [] });
    await expect(loadConfig()).rejects.toThrow('"port" must be an integer');
    await configWith('{nope');
    await expect(loadConfig()).rejects.toThrow('is not valid JSON');
    await configWith({ port: 1 });
    await expect(loadConfig()).rejects.toThrow('"projects" must be a list');
  });
});
