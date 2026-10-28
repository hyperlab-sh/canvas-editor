import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

/** A session that has not polled for this long is gone (AC-6). */
export const SESSION_TTL_MS = 10_000;
const SWEEP_MS = 1_000;

export interface SessionTiming {
  readonly ttlMs?: number;
  readonly sweepMs?: number;
}

export interface RegisterInput {
  readonly client: string;
  readonly cwd: string;
  readonly pid: number;
}

export interface Session {
  readonly id: string;
  readonly label: string;
  readonly client: string;
  readonly cwd: string;
  readonly pid: number;
  lastSeen: number;
  /** Open long-polls; a parked poll is alive however long it has waited. */
  parked: number;
  readonly bindings: Set<string>;
}

export type BindResult =
  | { readonly status: 'ok' }
  | { readonly status: 'held'; readonly holder: string };

export type HolderListener = (project: string, id: string, label: string | null) => void;

export interface Sessions {
  register(input: RegisterInput): { sessionId: string; label: string };
  get(sessionId: string): Session | undefined;
  /** Binds the diagram to the session; refused with the holder's label when another session has it (D13). Binding twice is fine. */
  bind(sessionId: string, project: string, id: string): BindResult;
  unbind(sessionId: string, project: string, id: string): void;
  /** Drops the session and every binding it holds. */
  release(sessionId: string): void;
  touch(sessionId: string): void;
  /** Marks a long-poll as open or closed; closing counts as a touch. */
  park(sessionId: string, open: boolean): void;
  /** The session holding the diagram. */
  holderOf(project: string, id: string): Session | undefined;
  /** Frees the diagram whoever holds it (the app's Disconnect). */
  disconnect(project: string, id: string): void;
  onHolder(listener: HolderListener): () => void;
  close(): void;
}

const keyOf = (project: string, id: string): string => `${project}/${id}`;
const splitKey = (key: string): [string, string] => {
  const slash = key.indexOf('/');
  return [key.slice(0, slash), key.slice(slash + 1)];
};

export function createSessions(timing: SessionTiming = {}): Sessions {
  const ttl = timing.ttlMs ?? SESSION_TTL_MS;
  const sessions = new Map<string, Session>();
  const holders = new Map<string, string>();
  const listeners = new Set<HolderListener>();

  const announce = (key: string, label: string | null): void => {
    const [project, id] = splitKey(key);
    for (const listener of listeners) {
      // A failing subscriber must not undo a binding that already changed.
      try {
        listener(project, id, label);
      } catch (error) {
        console.error(`service sessions: holder listener failed for ${key}:`, error);
      }
    }
  };

  const free = (key: string): void => {
    const sessionId = holders.get(key);
    if (sessionId === undefined) return;
    holders.delete(key);
    sessions.get(sessionId)?.bindings.delete(key);
    announce(key, null);
  };

  const release = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    for (const key of [...session.bindings]) free(key);
    sessions.delete(sessionId);
  };

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (session.parked === 0 && now - session.lastSeen >= ttl) release(session.id);
    }
  }, timing.sweepMs ?? SWEEP_MS);
  sweeper.unref();

  return {
    register: ({ client, cwd, pid }) => {
      const base = `${client} · ${basename(cwd) || cwd}`;
      // Two live sessions with one label are told apart by their process id.
      const taken = [...sessions.values()].some((session) => session.label === base);
      const label = taken ? `${base} (${pid})` : base;
      const id = randomUUID();
      sessions.set(id, { id, label, client, cwd, pid, lastSeen: Date.now(), parked: 0, bindings: new Set() });
      return { sessionId: id, label };
    },

    get: (sessionId) => sessions.get(sessionId),

    bind: (sessionId, project, id) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Unknown session ${sessionId}.`);
      const key = keyOf(project, id);
      const heldBy = holders.get(key);
      if (heldBy !== undefined && heldBy !== sessionId) return { status: 'held', holder: sessions.get(heldBy)?.label ?? heldBy };
      if (heldBy === undefined) {
        holders.set(key, sessionId);
        session.bindings.add(key);
        announce(key, session.label);
      }
      return { status: 'ok' };
    },

    unbind: (sessionId, project, id) => {
      const key = keyOf(project, id);
      if (holders.get(key) === sessionId) free(key);
    },

    release,

    touch: (sessionId) => {
      const session = sessions.get(sessionId);
      if (session) session.lastSeen = Date.now();
    },

    park: (sessionId, open) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.parked += open ? 1 : -1;
      if (!open) session.lastSeen = Date.now();
    },

    holderOf: (project, id) => {
      const sessionId = holders.get(keyOf(project, id));
      return sessionId === undefined ? undefined : sessions.get(sessionId);
    },

    disconnect: (project, id) => free(keyOf(project, id)),

    onHolder: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close: () => clearInterval(sweeper),
  };
}
