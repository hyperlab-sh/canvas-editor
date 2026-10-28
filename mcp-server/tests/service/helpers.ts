import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceConfig } from '../../src/service/config.js';

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ofk-service-'));
}

export async function tempConfig(...names: string[]): Promise<ServiceConfig> {
  const root = await tempDir();
  const projects = [];
  for (const name of names) {
    const path = join(root, name);
    await mkdir(path);
    projects.push({ name, path });
  }
  return { port: 0, projects, file: join(root, 'service.json') };
}

export async function putFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), 'utf8');
}
