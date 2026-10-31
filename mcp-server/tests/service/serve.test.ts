import { createServer, type Server, type Socket } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/service/config.js';
import { runServe } from '../../src/service/serve.js';
import { startService, type RunningService } from '../../src/service/serve.js';
import { tempConfig, tempDir } from './helpers.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (m: string) => out.push(m), err: (m: string) => err.push(m) } };
}

async function configFile(): Promise<string> {
  const config = await tempConfig('alpha');
  const file = join(await tempDir(), 'service.json');
  await writeFile(file, JSON.stringify({ ...config, port: 43120 }));
  return file;
}

async function holdPort(): Promise<{ server: Server; port: number }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => {
    server.close(resolve);
    for (const socket of sockets) socket.destroy();
  }));
  return { server, port: (server.address() as { port: number }).port };
}

describe('openflowkit serve', () => {
  it('listens, prints the URL, and answers /health on the printed port', async () => {
    const { io: sink, out } = io();
    let service: RunningService | undefined;
    const code = await runServe(['--port', '0', '--config', await configFile(), '--app', '/nonexistent'], sink, (s) => { service = s; closers.push(s.close); });
    expect(code).toBe(0);
    expect(out).toEqual([`openflowkit service listening on ${service!.url} (app: /nonexistent)`]);
    expect((await (await fetch(`${service!.url}/health`)).json()).port).toBe(service!.port);
    const root = await fetch(`${service!.url}/`);
    expect(root.status).toBe(503);
    expect(await root.text()).toContain('/nonexistent');
  });

  it('exits 1 naming the port when a plain server holds it', async () => {
    const { port } = await holdPort();
    const { io: sink, err, out } = io();
    expect(await runServe(['--port', String(port), '--config', await configFile()], sink)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain(`port ${port} is in use by something that is not an OpenFlowKit service`);
  });

  it('exits 0 saying it is already running when another OpenFlowKit service holds the port', async () => {
    const first = await startService({ port: 0, config: await loadConfig(await configFile()), appDir: '/nonexistent' });
    closers.push(first.close);
    const { io: sink, err, out } = io();
    expect(await runServe(['--port', String(first.port), '--config', await configFile()], sink)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([`openflowkit service is already running on http://127.0.0.1:${first.port}`]);
  });

  it('exits 1 when the port is held by an HTTP server that is not ours', async () => {
    const { createServer: http } = await import('node:http');
    const other = http((_, res) => res.end('{"service":"something-else"}'));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => { other.close(() => resolve(undefined)); other.closeAllConnections(); }));
    const port = (other.address() as { port: number }).port;
    const { io: sink, err } = io();
    expect(await runServe(['--port', String(port), '--config', await configFile()], sink)).toBe(1);
    expect(err[0]).toContain(`port ${port}`);
  });

  it('serves the app from OPENFLOWKIT_APP_DIR when --app is not given', async () => {
    const dir = join(await tempDir(), 'envapp');
    await mkdir(dir);
    await writeFile(join(dir, 'index.html'), '<html>from env</html>');
    const saved = process.env.OPENFLOWKIT_APP_DIR;
    process.env.OPENFLOWKIT_APP_DIR = dir;
    closers.push(async () => {
      if (saved === undefined) delete process.env.OPENFLOWKIT_APP_DIR;
      else process.env.OPENFLOWKIT_APP_DIR = saved;
    });
    const { io: sink, out } = io();
    let service: RunningService | undefined;
    expect(await runServe(['--port', '0', '--config', await configFile()], sink, (s) => { service = s; closers.push(s.close); })).toBe(0);
    expect(out).toEqual([`openflowkit service listening on ${service!.url} (app: ${dir})`]);
    expect(await (await fetch(`${service!.url}/`)).text()).toBe('<html>from env</html>');
  });

  it('falls back to the repository build folder when neither --app nor the variable is set', async () => {
    const saved = process.env.OPENFLOWKIT_APP_DIR;
    delete process.env.OPENFLOWKIT_APP_DIR;
    closers.push(async () => {
      if (saved !== undefined) process.env.OPENFLOWKIT_APP_DIR = saved;
    });
    const { io: sink, out } = io();
    expect(await runServe(['--port', '0', '--config', await configFile()], sink, (s) => closers.push(s.close))).toBe(0);
    expect(out[0]).toMatch(/ \(app: .*\/dist\)$/);
    expect(out[0]).not.toContain('mcp-server/dist');
  });

  it('rejects bad arguments with exit 2', async () => {
    for (const [args, message] of [
      [['--port', 'abc'], 'serve: --port must be an integer from 0 to 65535, got "abc".'],
      [['--port'], 'serve: --port needs a value.'],
      [['--wat', '1'], 'serve: unknown argument "--wat". Usage: openflowkit serve [--port N] [--host addr] [--config path] [--app dir]'],
    ] as const) {
      const { io: sink, err } = io();
      expect(await runServe(args, sink)).toBe(2);
      expect(err).toEqual([message]);
    }
  });

  it('binds loopback only', async () => {
    const service = await startService({ port: 0, config: await loadConfig(await configFile()), appDir: '/nonexistent' });
    closers.push(service.close);
    expect(service.address).toBe('127.0.0.1');
  });
});

/** First non-loopback IPv4 address of this machine, if it has one. */
const externalIp = Object.values(networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal)?.address;

const hasIpv6 = Object.values(networkInterfaces()).flat().some((a) => a?.family === 'IPv6' && a.address === '::1');

/** fetch forbids overriding Host; node:http does not. */
function getHealth(ip: string, port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: ip, port, path: '/health', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function serveWith(args: string[], env?: string) {
  const saved = process.env.OPENFLOWKIT_SERVICE_HOST;
  if (env === undefined) delete process.env.OPENFLOWKIT_SERVICE_HOST;
  else process.env.OPENFLOWKIT_SERVICE_HOST = env;
  closers.push(async () => {
    if (saved === undefined) delete process.env.OPENFLOWKIT_SERVICE_HOST;
    else process.env.OPENFLOWKIT_SERVICE_HOST = saved;
  });
  const sink = io();
  let service: RunningService | undefined;
  const code = await runServe(['--port', '0', '--config', await configFile(), '--app', '/nonexistent', ...args], sink.io, (s) => { service = s; closers.push(s.close); });
  return { code, service, out: sink.out, err: sink.err };
}

describe('openflowkit serve --host', () => {
  it('binds 127.0.0.1 and prints no warning without the flag or the variable', async () => {
    const { code, service, err } = await serveWith([]);
    expect(code).toBe(0);
    expect(service!.address).toBe('127.0.0.1');
    expect(err).toEqual([]);
    expect((await (await fetch(`${service!.url}/health`)).json()).host).toBe('127.0.0.1');
  });

  it('binds an explicit loopback address with no warning', async () => {
    const { service, err } = await serveWith(['--host', '127.0.0.1']);
    expect(service!.address).toBe('127.0.0.1');
    expect(err).toEqual([]);
  });

  it('binds all interfaces for --host 0.0.0.0, warns once, and reports the host in /health', async () => {
    const { code, service, err } = await serveWith(['--host', '0.0.0.0']);
    expect(code).toBe(0);
    expect(service!.address).toBe('0.0.0.0');
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('no authentication');
    expect((await (await fetch(`${service!.url}/health`)).json()).host).toBe('0.0.0.0');
  });

  it('binds the variable\'s address when there is no flag', async () => {
    const { code, service, err } = await serveWith([], '0.0.0.0');
    expect(code).toBe(0);
    expect(service!.address).toBe('0.0.0.0');
    expect(err).toHaveLength(1);
  });

  it('lets the flag win over the variable', async () => {
    const { code, service, err } = await serveWith(['--host', '127.0.0.1'], '0.0.0.0');
    expect(code).toBe(0);
    expect(service!.address).toBe('127.0.0.1');
    expect(err).toEqual([]);
  });

  it('fails at start naming the bad address, with exit 2 and nothing listening', async () => {
    for (const args of [['--host', 'not-an-address'], ['--host', '']]) {
      const { code, service, out, err } = await serveWith(args);
      expect(code).toBe(2);
      expect(service).toBeUndefined();
      expect(out).toEqual([]);
      expect(err[0]).toContain('is not an IP address');
    }
    const fromEnv = await serveWith([], '999.1.1.1');
    expect(fromEnv.code).toBe(2);
    expect(fromEnv.err[0]).toContain('"999.1.1.1"');
  });

  it('needs a value after --host', async () => {
    const { code, err } = await serveWith(['--host']);
    expect(code).toBe(2);
    expect(err[0]).toContain('--host needs a value');
  });

  it('refuses Host: evil.example with 403 under a 0.0.0.0 bind and answers a loopback Host', async () => {
    const { service } = await serveWith(['--host', '0.0.0.0']);
    expect((await getHealth('127.0.0.1', service!.port, 'evil.example')).status).toBe(403);
    const ok = await getHealth('127.0.0.1', service!.port, `127.0.0.1:${service!.port}`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).host).toBe('0.0.0.0');
  });

  it('exits 2 saying no interface has the address when it is not on this machine', async () => {
    const { code, service, out, err } = await serveWith(['--host', '192.0.2.1']);
    expect(code).toBe(2);
    expect(service).toBeUndefined();
    expect(out).toEqual([]);
    expect(err).toEqual(['openflowkit serve: cannot bind 192.0.2.1: no interface on this machine has that address.']);
  });

  it.skipIf(!hasIpv6)('binds :: with a [::1] url and one warning', async () => {
    const { code, service, err } = await serveWith(['--host', '::']);
    expect(code).toBe(0);
    expect(service!.address).toBe('::');
    expect(service!.url).toBe(`http://[::1]:${service!.port}`);
    expect(err).toHaveLength(1);
  });

  it.skipIf(!externalIp)('answers on a non-loopback interface for a loopback Host, and refuses any other Host with 403', async () => {
    const { service } = await serveWith(['--host', '0.0.0.0']);
    const ok = await getHealth(externalIp!, service!.port, `127.0.0.1:${service!.port}`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).host).toBe('0.0.0.0');
    for (const host of [`localhost:${service!.port}`, `[::1]:${service!.port}`]) expect((await getHealth(externalIp!, service!.port, host)).status).toBe(200);
    for (const host of ['evil.example', `${externalIp}:${service!.port}`]) expect((await getHealth(externalIp!, service!.port, host)).status).toBe(403);
  });
});
