import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeThreadEvent } from '../lib/agent.js';
import type { Sessions } from './sessions.js';
import type { Store } from './store.js';

/** The longest a session's events request may park. */
export const MAX_WAIT_S = 25;

export interface Events {
  /** Opens the SSE stream of one diagram on `response`: `revision` and `holder` events until the tab goes away. */
  subscribe(project: string, id: string, response: ServerResponse): void;
  /** Queues a thread event for the session; a parked poll gets it at once. */
  push(sessionId: string, project: string, event: BridgeThreadEvent): void;
  /** True when thread events are queued for the session; takes none of them. */
  pending(sessionId: string): boolean;
  /** Takes the session's queued events, parking up to `waitS` seconds when there are none. Null when none arrived. */
  poll(sessionId: string, waitS: number, request: IncomingMessage): Promise<BridgeThreadEvent[] | null>;
  close(): void;
}

interface Waiter {
  wake(): void;
}

export function createEvents(store: Store, sessions: Sessions): Events {
  const tabs = new Map<string, Set<ServerResponse>>();
  // The project is kept because diagram ids come from file contents, so two projects can share one.
  const queues = new Map<string, { project: string; event: BridgeThreadEvent }[]>();
  const waiters = new Map<string, Waiter>();

  const send = (project: string, id: string, event: string, data: unknown): void => {
    for (const response of tabs.get(`${project}/${id}`) ?? []) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const stopStore = store.changed((project, id, revision) => send(project, id, 'revision', { project, id, revision }));
  const stopSessions = sessions.onHolder((project, id, label) => {
    send(project, id, 'holder', { project, id, label });
    // Comments queued while the diagram was held are not for whoever connects next, nor for the session that lost it.
    if (label === null) {
      for (const [sessionId, queued] of queues) {
        const kept = queued.filter((entry) => !(entry.project === project && entry.event.documentId === id));
        if (kept.length) queues.set(sessionId, kept);
        else queues.delete(sessionId);
      }
    }
  });
  const stopRelease = sessions.onRelease((sessionId) => {
    queues.delete(sessionId);
    waiters.get(sessionId)?.wake();
  });

  const drain = (sessionId: string): BridgeThreadEvent[] | null => {
    const queued = queues.get(sessionId);
    if (!queued?.length) return null;
    queues.delete(sessionId);
    return queued.map((entry) => entry.event);
  };

  return {
    subscribe: (project, id, response) => {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      // The comment line makes the headers reach the tab now, not with the first event.
      response.write(': open\n\n');
      const key = `${project}/${id}`;
      const group = tabs.get(key) ?? new Set<ServerResponse>();
      group.add(response);
      tabs.set(key, group);
      response.once('close', () => {
        group.delete(response);
        if (group.size === 0 && tabs.get(key) === group) tabs.delete(key);
      });
    },

    push: (sessionId, project, event) => {
      queues.set(sessionId, [...(queues.get(sessionId) ?? []), { project, event }]);
      waiters.get(sessionId)?.wake();
    },

    pending: (sessionId) => (queues.get(sessionId)?.length ?? 0) > 0,

    poll: async (sessionId, waitS, request) => {
      sessions.touch(sessionId);
      const ready = drain(sessionId);
      if (ready || waitS <= 0) return ready;
      // A newer poll replaces an older one that is still parked (a reconnect that beat the old socket's close).
      waiters.get(sessionId)?.wake();
      sessions.park(sessionId, true);
      await new Promise<void>((done) => {
        const finish = (): void => {
          clearTimeout(timer);
          request.socket.off('close', finish);
          if (waiters.get(sessionId) === waiter) waiters.delete(sessionId);
          done();
        };
        const waiter: Waiter = { wake: finish };
        const timer = setTimeout(finish, Math.min(waitS, MAX_WAIT_S) * 1000);
        request.socket.once('close', finish);
        waiters.set(sessionId, waiter);
      });
      sessions.park(sessionId, false);
      // A poll whose client went away must not take the events.
      return request.socket.destroyed ? null : drain(sessionId);
    },

    close: () => {
      stopStore();
      stopSessions();
      stopRelease();
      for (const waiter of [...waiters.values()]) waiter.wake();
      for (const group of tabs.values()) for (const response of group) response.end();
      tabs.clear();
    },
  };
}
