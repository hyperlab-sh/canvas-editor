// A real agent on the page, for screenshots: pairs the open tab through its
// Connect agent panel with this repo's built MCP server (mcp-server/dist),
// started on its own port so it never touches a server already on 43119.
// Build the server first if dist is missing: npm --prefix mcp-server run build
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../mcp-server/dist/index.js', import.meta.url));

function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer().once('error', () => resolve(false)).once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** Opens Connect agent, points it at `port`, starts the MCP server with the page's own token, waits for "Connected". */
export async function connectAgent(page, port = Number(process.env.AGENT_PORT ?? 43147)) {
  if (!(await portFree(port))) throw new Error(`Port ${port} is taken; set AGENT_PORT to a free one.`);
  await page.getByRole('button', { name: 'Connect agent' }).first().click();
  const panel = page.locator('.ofk-connection-panel');
  const settings = panel.locator('summary', { hasText: 'Connection settings' });
  await settings.click();
  await page.locator('#ofk-bridge-port').fill(String(port));
  await page.locator('#ofk-bridge-port').blur();
  await settings.click();
  const config = JSON.parse(await panel.locator('pre.ofk-v2-bridge-snippet').first().textContent());
  const env = config.mcpServers.openflowkit.env;
  if (env.OPENFLOWKIT_BRIDGE_PORT !== String(port)) throw new Error(`Panel kept port ${env.OPENFLOWKIT_BRIDGE_PORT}`);
  await panel.getByRole('button', { name: /^Connect$/ }).click();
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER], env: { ...process.env, ...env }, stderr: 'ignore',
  });
  const client = new Client({ name: 'openflowkit-capture', version: '1' });
  await client.connect(transport);
  // The server's child process dies with this one, even on a crash or Ctrl+C.
  const kill = () => { try { process.kill(transport.pid); } catch { /* gone */ } };
  process.once('exit', kill);
  await page.locator('.ofk-connection-panel[data-status="connected"]').waitFor({ timeout: 40_000 });
  return {
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (result.isError) throw new Error(`${name}: ${text}`);
      try { return JSON.parse(text); } catch { return text; }
    },
    async close() { await client.close().catch(() => {}); kill(); },
  };
}
