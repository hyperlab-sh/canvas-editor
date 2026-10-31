// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// nginx/ai-proxy.sh writes the Docker image's AI proxy at container start. Not run in nginx here; `nginx -t` in the image is the
// check for the syntax, this is the check for what it lets through.
const run = (upstream?: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ofk-ai-proxy-'));
  try {
    execFileSync('sh', [path.resolve(__dirname, 'ai-proxy.sh')], {
      env: { PATH: process.env.PATH, OFK_NGINX_DIR: dir, ...(upstream === undefined ? {} : { OPENFLOWKIT_AI_UPSTREAM: upstream }) }, stdio: 'pipe',
    });
    return { ok: true as const, conf: readFileSync(path.join(dir, 'ai-proxy.conf'), 'utf8') };
  } catch (error) {
    return { ok: false as const, message: String((error as { stderr?: Buffer }).stderr ?? error) };
  }
};

describe('nginx AI proxy', () => {
  it('is off by default: every /ai-proxy/ path answers 503 with how to turn it on', () => {
    const result = run();
    expect(result.ok && result.conf).toContain('return 503');
    expect(result.ok && result.conf).toContain('OPENFLOWKIT_AI_UPSTREAM');
    expect(result.ok && result.conf).not.toContain('proxy_pass');
  });

  it('forwards exactly the model list and chat to the configured upstream, streaming, without the browser origin or logs', () => {
    const result = run('http://host.docker.internal:11434/v1/');
    if (!result.ok) throw new Error(result.message);
    const passes = [...result.conf.matchAll(/proxy_pass (\S+);/g)].map((match) => match[1]);
    expect(passes).toEqual(['http://host.docker.internal:11434/v1/models', 'http://host.docker.internal:11434/v1/chat/completions']);
    expect(result.conf).toContain('location = /ai-proxy/models {\n    limit_except GET');
    expect(result.conf).toContain('location = /ai-proxy/chat/completions {\n    limit_except POST');
    expect(result.conf).toMatch(/location \^~ \/ai-proxy\/ \{\n {4}return 404;/);
    for (const line of ['proxy_buffering off;', 'proxy_set_header Origin "";', 'proxy_set_header Cookie "";', 'access_log off;']) {
      expect(result.conf.split(line).length - 1).toBe(2);
    }
  });

  it('refuses an upstream that is not http(s) or could break out of the config', () => {
    for (const bad of ['ftp://x', 'localhost:11434', 'http://', 'http://x; return 200', 'http://x}', 'http://$host', "http://x'"]) {
      expect(run(bad).ok, bad).toBe(false);
    }
  });
});
