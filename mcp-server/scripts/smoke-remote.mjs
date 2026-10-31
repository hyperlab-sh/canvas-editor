// Smoke-checks a running remote endpoint with the SDK's own client: `npm run smoke:remote -- https://mcp.openflowkit.com`
// (or http://127.0.0.1:8787 against `npm run dev:remote`). Exit 1 when any check fails.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const timed = async (work) => { const started = Date.now(); const value = await work(); return [value, Date.now() - started]; };

const client = new Client({ name: 'openflowkit-smoke', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

const { tools } = await client.listTools();
check('tools/list has render_diagram, get_syntax and preview_diagram', tools.map((t) => t.name).sort().join() === 'get_syntax,preview_diagram,render_diagram');
check('preview_diagram is app-only', JSON.stringify(tools.find((t) => t.name === 'preview_diagram')?._meta?.ui?.visibility) === '["app"]');
check('render_diagram points at the viewer', tools.find((t) => t.name === 'render_diagram')?._meta?.ui?.resourceUri === 'ui://openflowkit/viewer.html');

const { contents } = await client.readResource({ uri: 'ui://openflowkit/viewer.html' });
check('viewer resource is the real viewer', contents[0]?.mimeType === 'text/html;profile=mcp-app' && contents[0]?.text.includes('ui/initialize'));

const [flow, flowMs] = await timed(() => client.callTool({ name: 'render_diagram', arguments: { source: 'flowchart\nCart -> Shipping\nShipping -> Payment\nPayment -> Done', title: 'Checkout' } }));
const card = flow.structuredContent ?? {};
check('flowchart renders', !flow.isError && String(card.svg).startsWith('<svg') && card.nodes === 4, `${flowMs} ms`);
check('flowchart has an editor link', /^https:\/\/app\.openflowkit\.com\/#\/from\/dsl\?d=/.test(String(card.openUrl)), String(card.openUrl).slice(0, 48));

const [mermaid, mermaidMs] = await timed(() => client.callTool({ name: 'render_diagram', arguments: { source: 'graph TD\n  A[User] --> B{Logged in?}\n  B -->|yes| C[Dashboard]\n  B -->|no| D[Login]' } }));
check('Mermaid converts and renders', !mermaid.isError && String(mermaid.structuredContent?.svg).startsWith('<svg'), `${mermaidMs} ms`);

const [icons, iconsMs] = await timed(() => client.callTool({ name: 'render_diagram', arguments: { source: 'flowchart\nAPI -> Postgres\nAPI -> Redis' } }));
const iconCount = (String(icons.structuredContent?.svg).match(/data:image\/svg\+xml/g) ?? []).length;
check('icon art loads (static assets)', iconCount >= 2, `${iconCount} icons, ${iconsMs} ms`);

const [preview, previewMs] = await timed(() => client.callTool({ name: 'preview_diagram', arguments: { source: 'flowchart\nCart -> Shipping' } }));
check('preview_diagram draws a keyed preview', !preview.isError && String(preview.structuredContent?.svg).includes('data-node-id="frame"'), `${previewMs} ms`);

const bad = await client.callTool({ name: 'render_diagram', arguments: { source: 'flowchart TD\n  A[[[ --> \n' } });
check('invalid source returns diagnostics', bad.isError === true && (bad.structuredContent?.diagnostics?.length ?? 0) > 0);

const grammar = await client.callTool({ name: 'get_syntax', arguments: { family: 'flowchart' } });
const grammarText = grammar.content?.[0]?.text ?? '';
check('get_syntax returns the grammar', !grammarText.includes('Grammar unavailable') && grammarText.length > 500, `${grammarText.length} chars`);
await client.close();

const raw = (path, init) => fetch(`${base}${path}`, init);
check('/healthz answers ok', (await (await raw('/healthz')).text()) === 'ok');
check('GET /mcp is 405', (await raw('/mcp', { method: 'GET' })).status === 405);
check('other paths are 404', (await raw('/nope', { method: 'POST', body: '{}' })).status === 404);
const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(600 * 1024) } });
check('a 600 KB body is 413', (await raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })).status === 413);
check('a non-JSON body is 400', (await raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: 'nope' })).status === 400);

console.log(failed ? `\n${failed} check(s) failed against ${base}` : `\nall checks passed against ${base}`);
process.exit(failed ? 1 : 0);
