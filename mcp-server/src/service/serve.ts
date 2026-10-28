import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliIo } from '../cli.js';
import { loadConfig, type ServiceConfig } from './config.js';
import { buildRoutes, createHandler, type Route } from './routes.js';
import { createEvents } from './events.js';
import { createSessions, type SessionTiming } from './sessions.js';
import { createStore } from './store.js';

export interface RunningService {
  readonly port: number;
  /** The address the socket is bound to. */
  readonly address: string;
  readonly url: string;
  close(): Promise<void>;
}

export interface StartOptions {
  readonly port: number;
  readonly config: ServiceConfig;
  readonly appDir: string;
  /** Extra route rows, tried after the API's and before the app fallback. */
  readonly routes?: readonly Route[];
  /** Session expiry and sweep interval; tests shorten them. */
  readonly sessionTiming?: SessionTiming;
}

/** `<mcp-server>/../dist`, from either src/service or dist/service. */
const defaultAppDir = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist');

/** Binds 127.0.0.1 only. Rejects with the listen error (EADDRINUSE included). */
export async function startService(options: StartOptions): Promise<RunningService> {
  const { config } = options;
  const store = createStore(config);
  const sessions = createSessions(options.sessionTiming);
  const events = createEvents(store, sessions);
  let bound = options.port;
  const table = [...buildRoutes(), ...(options.routes ?? [])];
  const server: Server = createServer(createHandler({ config, store, sessions, events, appDir: resolve(options.appDir), port: () => bound }, table));
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('The service socket has no address.');
  bound = address.port;
  return {
    port: bound,
    address: address.address,
    url: `http://127.0.0.1:${bound}`,
    close: () => new Promise<void>((done) => {
      sessions.close();
      events.close();
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}

/** True when `/health` on the port answers as an OpenFlowKit service. */
async function isOurService(port: number): Promise<boolean> {
  try {
    const reply = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return ((await reply.json()) as { service?: unknown }).service === 'openflowkit-service';
  } catch {
    return false;
  }
}

function parseArgs(args: readonly string[]): { port?: number; config?: string; app?: string } | string {
  const out: { port?: number; config?: string; app?: string } = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag !== '--port' && flag !== '--config' && flag !== '--app') return `serve: unknown argument "${flag}". Usage: openflowkit serve [--port N] [--config path] [--app dir]`;
    if (value === undefined) return `serve: ${flag} needs a value.`;
    i += 1;
    if (flag === '--port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) return `serve: --port must be an integer from 0 to 65535, got "${value}".`;
      out.port = port;
    } else if (flag === '--config') out.config = resolve(value);
    else out.app = resolve(value);
  }
  return out;
}

/**
 * Starts the service and returns once it listens; the server keeps the process alive.
 * Exit 1 when the port is held by something else, 0 when another OpenFlowKit service already has it.
 */
export async function runServe(args: readonly string[], io: CliIo, onStart?: (service: RunningService) => void): Promise<number> {
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') { io.err(parsed); return 2; }
  const config = await loadConfig(parsed.config);
  const port = parsed.port ?? config.port;
  const appDir = parsed.app ?? process.env.OPENFLOWKIT_APP_DIR ?? defaultAppDir();
  try {
    const service = await startService({ port, appDir, config });
    io.out(`openflowkit service listening on ${service.url} (app: ${resolve(appDir)})`);
    onStart?.(service);
    return 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    if (await isOurService(port)) {
      io.out(`openflowkit service is already running on http://127.0.0.1:${port}`);
      return 0;
    }
    io.err(`openflowkit serve: port ${port} is in use by something that is not an OpenFlowKit service. Free it, or pick another with --port or the config file.`);
    return 1;
  }
}
