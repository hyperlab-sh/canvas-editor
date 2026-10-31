import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliIo } from '../cli.js';
import { loadConfig, type ServiceConfig } from './config.js';
import { buildRoutes, createHandler, type Route } from './routes.js';
import { createEvents } from './events.js';
import { createSessions, type SessionTiming } from './sessions.js';
import { createStore } from './store.js';
import { CLI_NAME } from '../cliName.js';

export interface RunningService {
  readonly port: number;
  /** The address the socket is bound to. */
  readonly address: string;
  readonly url: string;
  close(): Promise<void>;
}

export interface StartOptions {
  readonly port: number;
  /** Address to bind; 127.0.0.1 when absent. */
  readonly host?: string;
  readonly config: ServiceConfig;
  readonly appDir: string;
  /** Extra route rows, tried after the API's and before the app fallback. */
  readonly routes?: readonly Route[];
  /** Session expiry and sweep interval; tests shorten them. */
  readonly sessionTiming?: SessionTiming;
}

/** `<mcp-server>/../dist`, from either src/service or dist/service. */
const defaultAppDir = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist');

const DEFAULT_HOST = '127.0.0.1';

/** An IP literal that reaches only this machine: 127.0.0.0/8, ::1 and its IPv4-mapped form. */
const isLoopback = (host: string): boolean => /^(127\.|::1$|::ffff:127\.)/i.test(host);

/** What a client on this machine types to reach a socket bound to `host`. */
function urlHost(host: string): string {
  if (host === '0.0.0.0') return DEFAULT_HOST;
  if (host === '::') return '[::1]';
  return isIP(host) === 6 ? `[${host}]` : host;
}

/** Binds `options.host` (127.0.0.1 by default). Rejects with the listen error (EADDRINUSE included). */
export async function startService(options: StartOptions): Promise<RunningService> {
  const { config } = options;
  const store = createStore(config);
  const sessions = createSessions(options.sessionTiming);
  const events = createEvents(store, sessions);
  let bound = options.port;
  const table = [...buildRoutes(), ...(options.routes ?? [])];
  let host = options.host ?? DEFAULT_HOST;
  const server: Server = createServer(createHandler({ config, store, sessions, events, appDir: resolve(options.appDir), port: () => bound, host: () => host }, table));
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('The service socket has no address.');
  bound = address.port;
  host = address.address;
  return {
    port: bound,
    address: address.address,
    url: `http://${urlHost(host)}:${bound}`,
    close: () => new Promise<void>((done) => {
      sessions.close();
      events.close();
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}

/** True when `/health` on the port answers as an OpenFlowKit service. */
async function isOurService(host: string, port: number): Promise<boolean> {
  try {
    const reply = await fetch(`http://${urlHost(host)}:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return ((await reply.json()) as { service?: unknown }).service === 'openflowkit-service';
  } catch {
    return false;
  }
}

function parseArgs(args: readonly string[]): { port?: number; host?: string; config?: string; app?: string } | string {
  const out: { port?: number; host?: string; config?: string; app?: string } = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag !== '--port' && flag !== '--host' && flag !== '--config' && flag !== '--app') return `serve: unknown argument "${flag}". Usage: ${CLI_NAME} serve [--port N] [--host addr] [--config path] [--app dir]`;
    if (value === undefined) return `serve: ${flag} needs a value.`;
    i += 1;
    if (flag === '--port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) return `serve: --port must be an integer from 0 to 65535, got "${value}".`;
      out.port = port;
    } else if (flag === '--host') out.host = value;
    else if (flag === '--config') out.config = resolve(value);
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
  const host = parsed.host ?? (process.env.OPENFLOWKIT_SERVICE_HOST || DEFAULT_HOST);
  if (isIP(host) === 0) {
    io.err(`${CLI_NAME} serve: bind address "${host}" is not an IP address. Use --host or OPENFLOWKIT_SERVICE_HOST with e.g. 127.0.0.1, 0.0.0.0 or ::.`);
    return 2;
  }
  const appDir = parsed.app ?? process.env.OPENFLOWKIT_APP_DIR ?? defaultAppDir();
  try {
    const service = await startService({ port, host, appDir, config });
    io.out(`${CLI_NAME} service listening on ${service.url} (app: ${resolve(appDir)})`);
    if (!isLoopback(service.address)) io.err(`${CLI_NAME} serve: warning: listening on ${service.address}, which other machines can reach; the service has no authentication.`);
    onStart?.(service);
    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
      io.err(`${CLI_NAME} serve: cannot bind ${host}: no interface on this machine has that address.`);
      return 2;
    }
    if (code !== 'EADDRINUSE') throw error;
    if (await isOurService(host, port)) {
      io.out(`${CLI_NAME} service is already running on http://${urlHost(host)}:${port}`);
      return 0;
    }
    io.err(`${CLI_NAME} serve: port ${port} is in use by something that is not an OpenFlowKit service. Free it, or pick another with --port or the config file.`);
    return 1;
  }
}
