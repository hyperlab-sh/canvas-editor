import { createServer } from 'node:http';
import { afterEach } from 'vitest';
import { createEvents } from '../../src/service/events.js';
import { createHandler } from '../../src/service/routes.js';
import { createSessions } from '../../src/service/sessions.js';
import type { Store } from '../../src/service/store.js';
import type { ServiceConfig } from '../../src/service/config.js';
import { startService, type RunningService } from '../../src/service/serve.js';
import type { SessionTiming } from '../../src/service/sessions.js';
import { tempConfig, tempDir } from './helpers.js';
import { join } from 'node:path';

const running: RunningService[] = [];
export function closeServicesAfterEach(): void {
  afterEach(async () => {
    await Promise.all(running.splice(0).map((service) => service.close()));
  });
}

/** A real service on port 0 over a temp config with one project, `alpha`. */
export async function boot(sessionTiming?: SessionTiming) {
  const config = await tempConfig('alpha');
  const service = await startService({ port: 0, config, appDir: join(await tempDir(), 'no-app'), ...(sessionTiming ? { sessionTiming } : {}) });
  running.push(service);
  return { service, config, folder: config.projects[0]!.path };
}

export async function call(service: { url: string }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${service.url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  // Replies are asserted by shape in each test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, json };
}

export async function register(service: RunningService, client = 'Claude Code', cwd = '/x/hyper', pid = 100) {
  const { json } = await call(service, 'POST', '/sessions', { client, cwd, pid });
  return json as { sessionId: string; label: string };
}

export async function newDiagram(service: RunningService, name = 'Flow') {
  const { json } = await call(service, 'POST', '/projects/alpha/diagrams', { name });
  return json as { id: string; revision: number };
}

export const bind = (service: { url: string }, sessionId: string, id: string) =>
  call(service, 'POST', `/sessions/${sessionId}/bindings`, { project: 'alpha', id });

/** An open SSE stream; `next` resolves with the next event of that name or rejects after `ms`. */
export async function openStream(service: RunningService, id: string) {
  const abort = new AbortController();
  const response = await fetch(`${service.url}/events?project=alpha&id=${id}`, { signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (name: string, ms = 2000): Promise<unknown> => {
    const deadline = AbortSignal.timeout(ms);
    for (;;) {
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      const rest: string[] = [];
      let found: unknown;
      for (const [index, frame] of frames.entries()) {
        const match = /^event: (\S+)\ndata: (.*)$/m.exec(frame);
        if (match && match[1] === name) { found = JSON.parse(match[2]!); rest.push(...frames.slice(index + 1)); break; }
      }
      if (found !== undefined) { buffer = rest.map((frame) => `${frame}\n\n`).join('') + buffer; return found; }
      buffer = frames.map((frame) => `${frame}\n\n`).join('') + buffer;
      const read = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(new Error(`No "${name}" event within ${ms} ms.`)))),
      ]);
      if (read.done) throw new Error('The stream ended.');
      buffer += decoder.decode(read.value);
    }
  };
  return { status: response.status, next, close: () => abort.abort() };
}

/** The service handler over an injected store, on a real listening socket: for races a plain store cannot produce. */
export async function serveWith(config: ServiceConfig, store: Store, sessions = createSessions()) {
  const events = createEvents(store, sessions);
  const server = createServer(createHandler({ config, store, sessions, events, appDir: '/nonexistent', port: () => 0 }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    sessions,
    close: async () => {
      events.close();
      sessions.close();
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
