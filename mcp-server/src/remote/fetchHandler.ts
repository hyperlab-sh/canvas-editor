// The remote endpoint as a fetch handler (Request in, Response out), for Cloudflare Workers.
// The hosted endpoint: stateless, POST on /mcp (or / and /mcp/), Host-checked, size- and render-capped, CORS open to any origin
// (no login, nothing stored), any Accept. The Node server in http.ts shares the paths and caps but is for localhost self-hosting:
// no CORS (a page on the same machine has no business calling it) and the SDK's own Accept rule.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createRemoteServer, type RemoteServerOptions } from './server.js';
import { acceptBoth, CORS_HEADERS, hostname, isPreviewOnly, isRender, MAX_BODY_BYTES, MCP_PATHS, rpcErrorBody } from './guards.js';

export interface FetchHandlerOptions extends Pick<RemoteServerOptions, 'deadlineMs' | 'layout'> {
  readonly viewerHtml: string;
  readonly appOrigin: string;
  /** Hostnames (no port) the Host header may carry; DNS-rebinding protection. */
  readonly allowedHosts: readonly string[];
  /** Renders in flight at once in this isolate; past it a render waits for a slot. */
  readonly maxRenders?: number;
  /** How long a render waits for a slot before it gets 503 + Retry-After; 0 answers 503 at once. */
  readonly queueMs?: number;
}

const rpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(rpcErrorBody(message), { status, headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...headers } });

/** The transport's answer with CORS added (its headers may be immutable). */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The body as text, or null once it passes the cap (reading stops there). */
async function readCapped(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function createFetchHandler({ viewerHtml, appOrigin, allowedHosts, maxRenders = 4, queueMs = 0, ...tool }: FetchHandlerOptions): (request: Request) => Promise<Response> {
  // A burst of quick renders queues briefly instead of failing: a refused call is an error in the user's chat.
  let renders = 0;
  const waiting: (() => void)[] = [];
  const acquire = (wait: number): Promise<boolean> => {
    if (renders < maxRenders) { renders += 1; return Promise.resolve(true); }
    if (wait <= 0) return Promise.resolve(false);
    return new Promise((done) => {
      const wake = () => { clearTimeout(timer); renders += 1; done(true); };
      const timer = setTimeout(() => { waiting.splice(waiting.indexOf(wake), 1); done(false); }, wait);
      waiting.push(wake);
    });
  };
  const release = () => { renders -= 1; waiting.shift()?.(); };
  return async (request) => {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/healthz') return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      const header = request.headers.get('host') ?? new URL(request.url).host;
      const host = hostname(header);
      if (!host || !allowedHosts.includes(host)) return rpcError(403, `Invalid Host: ${header || 'missing'}`);
      if (!MCP_PATHS.has(path)) return rpcError(404, 'Not found. The MCP endpoint is /mcp.');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      // Stateless: no session to resume (GET would hold an SSE stream open forever) or end (DELETE).
      if (request.method !== 'POST') return rpcError(405, 'Method not allowed', { allow: 'POST' });
      if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return rpcError(413, 'Request body over 512 KB');

      const body = await readCapped(request);
      if (body === null) return rpcError(413, 'Request body over 512 KB');
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { return rpcError(400, 'Body is not JSON'); }
      const render = isRender(parsed);
      if (render && !await acquire(isPreviewOnly(parsed) ? 0 : queueMs)) return rpcError(503, 'Too many diagrams rendering; retry shortly', { 'retry-after': '2' });
      const server = createRemoteServer({ viewerHtml, appOrigin, ...tool });
      // JSON responses, not SSE: the answer is ready once the call returns, so the render count is exact.
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await server.connect(transport);
        // The body is already parsed; a client asking only for JSON (or anything) gets the JSON a stateless call returns.
        const copied = () => {
          // The body is already read (parsedBody): a length or encoding header would describe a body this request no longer has.
          const headers = new Headers(request.headers);
          headers.delete('content-length');
          headers.delete('transfer-encoding');
          headers.set('accept', 'application/json, text/event-stream');
          return new Request(request.url, { method: 'POST', headers });
        };
        const accepted = acceptBoth(request.headers.get('accept')) ? request : copied();
        return withCors(await transport.handleRequest(accepted, { parsedBody: parsed }));
      } finally {
        if (render) release();
        void transport.close();
        void server.close();
      }
    } catch (error) {
      console.error('openflowkit-remote:', error);
      return rpcError(500, 'Internal error');
    }
  };
}
