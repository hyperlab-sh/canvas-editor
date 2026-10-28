import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectConfig, ServiceConfig } from './config.js';

export const DIAGRAM_SUFFIX = '.openflow.json';

export interface DiagramSummary {
  readonly id: string;
  readonly title: string;
  readonly modifiedAt: string;
}

export interface ProjectListing {
  readonly name: string;
  readonly path: string;
  readonly diagrams: readonly DiagramSummary[];
}

export interface ResolvedDiagram {
  readonly project: string;
  readonly id: string;
  readonly path: string;
}

interface Entry extends DiagramSummary {
  readonly file: string;
  readonly path: string;
}

interface Cached {
  readonly mtimeMs: number;
  readonly size: number;
  readonly head: { readonly id: string; readonly title: string } | null;
}

/** Parsed id and name per file, valid while (path, mtime, size) are unchanged. */
const cache = new Map<string, Cached>();

async function headOf(path: string, mtimeMs: number, size: number): Promise<Cached['head']> {
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.head;
  let head: Cached['head'] = null;
  try {
    const { id, name } = JSON.parse(await readFile(path, 'utf8')) as { id?: unknown; name?: unknown };
    if (typeof id === 'string' && id) head = { id, title: typeof name === 'string' ? name : id };
  } catch {
    // Not JSON (yet): skipped until the file changes.
  }
  cache.set(path, { mtimeMs, size, head });
  return head;
}

async function scan(project: ProjectConfig): Promise<Entry[]> {
  const files = (await readdir(project.path)).filter((file) => file.endsWith(DIAGRAM_SUFFIX)).sort();
  const entries: Entry[] = [];
  for (const file of files) {
    const path = join(project.path, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const head = await headOf(path, info.mtimeMs, info.size);
    if (head) entries.push({ ...head, file, path, modifiedAt: info.mtime.toISOString() });
  }
  return entries;
}

export function projectNamed(config: ServiceConfig, name: string): ProjectConfig {
  const project = config.projects.find((candidate) => candidate.name === name);
  if (!project) throw new Error(`Unknown project "${name}". Configured: ${config.projects.map((p) => p.name).join(', ') || 'none'}.`);
  return project;
}

/** Lists every project's diagrams; a duplicate id lists its first file only. */
export async function listDiagrams(config: ServiceConfig): Promise<ProjectListing[]> {
  return Promise.all(config.projects.map(async (project) => {
    const seen = new Set<string>();
    const diagrams: DiagramSummary[] = [];
    for (const { id, title, modifiedAt } of await scan(project)) {
      if (seen.has(id)) continue;
      seen.add(id);
      diagrams.push({ id, title, modifiedAt });
    }
    return { name: project.name, path: project.path, diagrams };
  }));
}

export async function resolveDiagram(config: ServiceConfig, projectName: string, id: string): Promise<ResolvedDiagram> {
  const project = projectNamed(config, projectName);
  const [first, second] = (await scan(project)).filter((entry) => entry.id === id);
  if (!first) throw new Error(`No diagram "${id}" in project "${projectName}".`);
  if (second) {
    throw new Error(`Diagram id "${id}" appears in both ${first.file} and ${second.file} in project "${projectName}"; rename or remove one.`);
  }
  return { project: projectName, id, path: first.path };
}
