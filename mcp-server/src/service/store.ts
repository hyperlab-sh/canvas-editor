import { randomUUID } from 'node:crypto';
import { link, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentDocument, parseAgentDocument, type SceneDocumentV1 } from '../lib/agent.js';
import type { ServiceConfig } from './config.js';
import { DIAGRAM_SUFFIX, projectNamed, resolve } from './projects.js';

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
  const revisions = new Map<string, { revision: number; mtimeMs: number }>();
  const listeners = new Set<ChangedListener>();
  const queues = new Map<string, Promise<unknown>>();

  const emit = (project: string, id: string, revision: number): void => {
    for (const listener of listeners) {
      // A failing subscriber must not fail a write that already succeeded.
      try {
        listener(project, id, revision);
      } catch (error) {
        console.error(`service store: changed listener failed for ${project}/${id}:`, error);
      }
    }
  };

  /** Temp file then rename: a crash or a concurrent listing never sees a half-written diagram. */
  const replace = async (path: string, document: SceneDocumentV1): Promise<void> => {
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, serialize(document), 'utf8');
    await rename(temp, path);
  };

  /** One operation at a time per diagram, so compare and write cannot interleave. */
  const serial = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(run, run);
    const tail = next.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return next;
  };

  /** Current revision; a file changed outside the store (hand edit, CLI save) moves it forward and announces it. */
  const revisionOf = async (project: string, id: string, path: string): Promise<number> => {
    const key = `${project}/${id}`;
    const { mtimeMs } = await stat(path);
    const known = revisions.get(key);
    if (!known) {
      revisions.set(key, { revision: Math.floor(mtimeMs), mtimeMs });
      return Math.floor(mtimeMs);
    }
    if (known.mtimeMs === mtimeMs) return known.revision;
    const revision = Math.max(known.revision + 1, Math.floor(mtimeMs));
    revisions.set(key, { revision, mtimeMs });
    emit(project, id, revision);
    return revision;
  };

  const load = async (path: string): Promise<SceneDocumentV1> => parseAgentDocument(JSON.parse(await readFile(path, 'utf8')));

  return {
    read: (project, id) => serial(`${project}/${id}`, async () => {
      const { path } = await resolve(config, project, id);
      return { document: await load(path), revision: await revisionOf(project, id, path) };
    }),

    write: (project, id, document, expectedRevision) => serial(`${project}/${id}`, async () => {
      const valid = parseAgentDocument(document);
      if (valid.id !== id) throw new Error(`Document id "${valid.id}" does not match diagram "${id}".`);
      const { path } = await resolve(config, project, id);
      const current = await revisionOf(project, id, path);
      if (current !== expectedRevision) return { status: 'stale', revision: current, document: await load(path) };
      await replace(path, valid);
      const revision = current + 1;
      revisions.set(`${project}/${id}`, { revision, mtimeMs: (await stat(path)).mtimeMs });
      emit(project, id, revision);
      return { status: 'ok', revision };
    }),

    create: async (project, name) => {
      const { path: folder } = projectNamed(config, project);
      const document = createAgentDocument(name);
      const slug = slugOf(name);
      for (let n = 1; ; n += 1) {
        const path = join(folder, `${n === 1 ? slug : `${slug}-${n}`}${DIAGRAM_SUFFIX}`);
        // Written whole to a temp name, then linked into place: exclusive like 'wx', never half-written.
        const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temp, serialize(document), 'utf8');
        try {
          await link(temp, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        } finally {
          await unlink(temp);
        }
        const revision = await revisionOf(project, document.id, path);
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
