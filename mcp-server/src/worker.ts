// The remote MCP endpoint on Cloudflare Workers (wrangler.toml): https://mcp.openflowkit.com/mcp.
// Stateless and stores nothing; the grammar and icon data are the Worker's static assets (data/).
import viewerHtml from './viewer/viewer.html';
import { createFetchHandler } from './remote/fetchHandler.js';
import { setDataReader } from './lib/fileCapabilities.js';
import { DEFAULT_APP_ORIGIN } from './lib/openLink.js';

interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly APP_ORIGIN?: string;
  /** Comma-separated hostnames the Host header may carry. */
  readonly ALLOWED_HOSTS?: string;
}

// ponytail: elkjs takes "self without document" for a Web Worker and never exports its in-process engine
// (`_Worker is not a constructor`); a Worker isolate looks exactly like that. Hiding `self` makes ELK run in
// process, as it does in Node. Upgrade path: construct ELK with a workerFactory once elkjs can run in-process here.
Object.defineProperty(globalThis, 'self', { value: undefined, configurable: true, writable: true });

let handler: ((request: Request) => Promise<Response>) | null = null;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (!handler) {
      setDataReader(async (path) => {
        const response = await env.ASSETS.fetch(new Request(`https://assets.local/${path}`));
        return response.ok ? response.text() : '';
      });
      handler = createFetchHandler({
        viewerHtml,
        appOrigin: env.APP_ORIGIN || DEFAULT_APP_ORIGIN,
        allowedHosts: (env.ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean),
        // ponytail: a per-isolate cap with a short queue (renders take ~10-150 ms); it bounds one isolate's memory, not the fleet.
        maxRenders: 8,
        queueMs: 10_000,
      });
    }
    return handler(request);
  },
};
