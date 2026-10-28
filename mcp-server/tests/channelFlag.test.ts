import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LiveBridge } from '../src/lib/bridge.js';
import { createServerWithDeps } from '../src/server.js';

// `channel` tells the agent whether this client declared claude/channel, i.e. whether thread events can reach it.

let bridge: LiveBridge | null = null;
afterEach(async () => { await bridge?.stop(); bridge = null; });

async function connect(capabilities: { experimental?: Record<string, object> }) {
  bridge = new LiveBridge({ port: 0, log: () => undefined });
  const { server } = createServerWithDeps({ bridge, log: () => undefined });
  const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function channelOf(client: Client, name: 'server_info' | 'whoami') {
  const result = await client.callTool({ name, arguments: {} }) as { content: Array<{ text: string }> };
  return (JSON.parse(result.content[0].text) as { channel: unknown }).channel;
}

describe('channel flag', () => {
  it.each(['server_info', 'whoami'] as const)('%s says true for a client that declares claude/channel', async (name) => {
    const client = await connect({ experimental: { 'claude/channel': {} } });
    expect(await channelOf(client, name)).toBe(true);
  });

  it.each(['server_info', 'whoami'] as const)('%s says false without it', async (name) => {
    expect(await channelOf(await connect({}), name)).toBe(false);
  });

  it.each(['server_info', 'whoami'] as const)('%s says false when other experimental capabilities are declared', async (name) => {
    expect(await channelOf(await connect({ experimental: { other: {} } }), name)).toBe(false);
  });
});

describe('OPENFLOWKIT_CHANNEL (D15)', () => {
  const saved = process.env.OPENFLOWKIT_CHANNEL;
  afterEach(() => { if (saved === undefined) delete process.env.OPENFLOWKIT_CHANNEL; else process.env.OPENFLOWKIT_CHANNEL = saved; });

  it.each(['server_info', 'whoami'] as const)('%s says true for a client that advertises nothing when the environment sets it to 1', async (name) => {
    process.env.OPENFLOWKIT_CHANNEL = '1';
    expect(await channelOf(await connect({}), name)).toBe(true);
  });

  it.each(['server_info', 'whoami'] as const)('%s says false when it is unset or anything but 1', async (name) => {
    delete process.env.OPENFLOWKIT_CHANNEL;
    expect(await channelOf(await connect({}), name)).toBe(false);
    process.env.OPENFLOWKIT_CHANNEL = '0';
    expect(await channelOf(await connect({}), name)).toBe(false);
  });
});
