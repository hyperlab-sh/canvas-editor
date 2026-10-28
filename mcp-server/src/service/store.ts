import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentDocument, parseAgentDocument, type SceneDocumentV1 } from '../lib/agent.js';
import type { ServiceConfig } from './config.js';
import { DIAGRAM_SUFFIX, projectNamed, resolveDiagram } from './projects.js';

export type ChangedListener = (project: string, id: string, revision: number) => void;

export type WriteResult =
  | { readonly status: 'ok'; readonly revision: number }
  | { readonly status: 'stale'; readonly revision: number; readonly document: SceneDocumentV1 };

export interface Store {
  read(project: string, id: string): Promise<{ document: SceneDocumentV1; revision: number }>;
  /** Compare-and-swap: writes only when `expectedRevision` is the diagram's current revision. */
  write(project: string, id: string, document: SceneDocumentV1, expectedRevision: number): Promise<WriteResult>;
  create(project: string, name: string): Promise<{ id: string; project: string; revision: number; document: SceneDocumentV1 }>;
  /** Subscribes to every write and create; returns the unsubscribe. */
  changed(listener: ChangedListener): () => void;
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram';
}

/** The same bytes `DocumentStore.save` writes. */
function serialize(document: SceneDocumentV1): string {
  return JSON.stringify(document, null, 2) + '\n';
}

/** The one module that writes project files. Revisions live in memory, seeded from mtime at first sight. */
export function createStore(config: ServiceConfig): Store {
  const revisions = new Map<string, number>();
  const listeners = new Set<ChangedListener>();
  const queues = new Map<string, Promise<unknown>>();

  const emit = (project: string, id: string, revision: number): void => {
    for (const listener of listeners) listener(project, id, revision);
  };

  /** One operation at a time per diagram, so compare and write cannot interleave. */
  const serial = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(run, run);
    queues.set(key, next.catch(() => undefined));
    return next;
  };

  const revisionOf = async (key: string, path: string): Promise<number> => {
    const known = revisions.get(key);
    if (known !== undefined) return known;
    const revision = Math.floor((await stat(path)).mtimeMs);
    revisions.set(key, revision);
    return revision;
  };

  const load = async (path: string): Promise<SceneDocumentV1> => parseAgentDocument(JSON.parse(await readFile(path, 'utf8')));

  return {
    read: (project, id) => serial(`${project}/${id}`, async () => {
      const { path } = await resolveDiagram(config, project, id);
      return { document: await load(path), revision: await revisionOf(`${project}/${id}`, path) };
    }),

    write: (project, id, document, expectedRevision) => serial(`${project}/${id}`, async () => {
      if (document.id !== id) throw new Error(`Document id "${document.id}" does not match diagram "${id}".`);
      const key = `${project}/${id}`;
      const { path } = await resolveDiagram(config, project, id);
      const current = await revisionOf(key, path);
      if (current !== expectedRevision) return { status: 'stale', revision: current, document: await load(path) };
      await writeFile(path, serialize(document), 'utf8');
      const revision = current + 1;
      revisions.set(key, revision);
      emit(project, id, revision);
      return { status: 'ok', revision };
    }),

    create: async (project, name) => {
      const { path: folder } = projectNamed(config, project);
      const document = createAgentDocument(name);
      const slug = slugOf(name);
      for (let n = 1; ; n += 1) {
        const path = join(folder, `${n === 1 ? slug : `${slug}-${n}`}${DIAGRAM_SUFFIX}`);
        try {
          await writeFile(path, serialize(document), { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
        const revision = await revisionOf(`${project}/${document.id}`, path);
        emit(project, document.id, revision);
        return { id: document.id, project, revision, document };
      }
    },

    changed: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
