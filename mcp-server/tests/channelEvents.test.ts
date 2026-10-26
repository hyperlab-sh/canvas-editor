import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { bridgeUrls, type BridgeCommentEvent } from '../src/lib/agent.js';
import { LiveBridge } from '../src/lib/bridge.js';
import { createServerWithDeps, INSTRUCTIONS } from '../src/server.js';

// Live comments: the editor posts a human message to POST /event; the process that owns the port pushes it into
// the agent's session as a Claude Code channel notification.

const EVENT: BridgeCommentEvent = {
  type: 'comment', documentId: 'doc-1', pageId: 'p1', threadId: 't1', messageId: 'm1',
  nodeId: 'n1', nodeLabel: 'API', kind: 'new_thread', author: 'Ana', body: 'Why is this synchronous?',
};

type Notice = { method: string; params: { content: string; meta: Record<string, string> } };

let bridge: LiveBridge | null = null;
afterEach(async () => { await bridge?.stop(); bridge = null; });

async function start(token?: string) {
  bridge = new LiveBridge({ port: 0, ...(token ? { token } : {}), log: () => undefined });
  const { server } = createServerWithDeps({ bridge, log: () => undefined });
  const client = new Client({ name: 'claude-code', version: '0.0.0' });
  const notices: Notice[] = [];
  // Other notifications (list changes) are not this feature's.
  client.fallbackNotificationHandler = async (notice) => { if (notice.method === 'notifications/claude/channel') notices.push(notice as unknown as Notice); };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const port = await bridge.start();
  return { client, notices, url: bridgeUrls(port).event };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', ...headers }, body: JSON.stringify(body) });

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('live comment events', () => {
  it('always declares the claude/channel capability, and the instructions explain the tag', async () => {
    const { client } = await start();
    expect(client.getServerCapabilities()?.experimental).toMatchObject({ 'claude/channel': {} });
    expect(INSTRUCTIONS).toMatch(/<channel source="openflowkit" thread_id/);
    expect(INSTRUCTIONS).toMatch(/If live comments are on/);
  });

  it('POST /event emits notifications/claude/channel with the body as content and snake_case meta', async () => {
    const { notices, url } = await start();
    const reply = await post(url, EVENT);
    expect(reply.status).toBe(200);
    await settle();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      method: 'notifications/claude/channel',
      params: {
        content: 'Why is this synchronous?',
        meta: { document_id: 'doc-1', page_id: 'p1', thread_id: 't1', node_id: 'n1', node_label: 'API', kind: 'new_thread', author: 'Ana' },
      },
    });
    for (const key of Object.keys(notices[0]!.params.meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it('leaves null node fields out of meta rather than sending empty attributes', async () => {
    const { notices, url } = await start();
    await post(url, { ...EVENT, nodeId: null, nodeLabel: null, kind: 'reply' });
    await settle();
    const meta = notices[0]!.params.meta;
    expect(meta).not.toHaveProperty('node_id');
    expect(meta).not.toHaveProperty('node_label');
    expect(meta.kind).toBe('reply');
    expect(Object.values(meta).every((value) => typeof value === 'string')).toBe(true);
  });

  it('requires the token, and refuses foreign origins', async () => {
    const { notices, url } = await start('secret');
    expect((await post(url, EVENT)).status).toBe(401);
    expect((await post(`${url}?token=wrong`, EVENT)).status).toBe(401);
    expect((await post(`${url}?token=secret`, EVENT, { origin: 'https://evil.example' })).status).toBe(403);
    await settle();
    expect(notices).toHaveLength(0);
    expect((await post(`${url}?token=secret`, EVENT, { origin: 'http://localhost:5173' })).status).toBe(200);
    await settle();
    expect(notices).toHaveLength(1);
  });

  it('rejects a malformed event with 400 and emits nothing', async () => {
    const { notices, url } = await start();
    expect((await post(url, { ...EVENT, kind: 'edit' })).status).toBe(400);
    expect((await post(url, { type: 'comment' })).status).toBe(400);
    expect((await post(url, { ...EVENT, body: 7 })).status).toBe(400);
    await settle();
    expect(notices).toHaveLength(0);
  });
});
