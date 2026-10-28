import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SceneDocumentV1 } from '../../domain/document/types';
import { createTestDocument, createTestNode } from '../../testing/builders/documentBuilder';
import type { ServiceRepository } from '../../../services/storage/v2/serviceSync';
import { deliverThreadEvent, setThreadEventSender } from '../../../agent/bridge/threadEvent';
import { useServiceSync } from './useServiceSync';

type Listener = (event?: unknown) => void;
const sources: FakeSource[] = [];
class FakeSource {
  readonly listeners = new Map<string, Listener>();
  constructor(readonly url: string) { sources.push(this); }
  addEventListener(name: string, listener: Listener) { this.listeners.set(name, listener); }
  close() { /* nothing to release */ }
}

beforeEach(() => { sources.length = 0; vi.stubGlobal('EventSource', FakeSource); });
afterEach(() => vi.unstubAllGlobals());

const local = createTestDocument({ nodes: [createTestNode('a')] });
const incoming = createTestDocument({ nodes: [createTestNode('a'), createTestNode('b')] });

function setup(options: { unsaved?: boolean; fetchCurrent: ServiceRepository['fetchCurrent']; repository?: Partial<ServiceRepository> }) {
  const repository = {
    eventsUrl: () => 'events',
    fetchCurrent: options.fetchCurrent,
    serviceRevision: () => 0,
    adopt: vi.fn(),
    ...options.repository,
  } as unknown as ServiceRepository;
  const replaceDocument = vi.fn((_document: SceneDocumentV1, _label: string) => 1);
  const pushToast = vi.fn();
  const adoptSaved = vi.fn();
  const hook = renderHook(() => useServiceSync({
    repository, id: 'd1', load: { phase: 'ready', readOnly: false, baseRevision: 3 },
    session: { document: local, revision: 0, replaceDocument, updateThreads: vi.fn(() => 1) },
    unsaved: options.unsaved ?? false, adoptSaved, pushToast,
  }));
  return { hook, replaceDocument, pushToast, adoptSaved, fire: (name: string, event?: unknown) => sources[0]!.listeners.get(name)?.(event) };
}

it('a 409 that lands while an event read is running still takes the copy and says so', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const { hook, pushToast, replaceDocument, fire } = setup({
    fetchCurrent: async () => { calls += 1; if (calls === 1) await gate; return { document: incoming, revision: 5, holder: null }; },
  });
  await act(async () => { fire('revision'); });
  await act(async () => { hook.result.current.onConflict(); });
  expect(pushToast).not.toHaveBeenCalled();
  await act(async () => { release(); await gate; });
  await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Updated from the service' })));
  expect(replaceDocument).toHaveBeenCalled();
});

it('an event leaves unsaved edits alone, a conflict does not', async () => {
  const { hook, pushToast, replaceDocument, fire } = setup({
    unsaved: true, fetchCurrent: async () => ({ document: incoming, revision: 5, holder: 'Claude Code' }),
  });
  await act(async () => { fire('revision'); });
  expect(replaceDocument).not.toHaveBeenCalled();
  expect(hook.result.current.holder).toBe('Claude Code');
  await act(async () => { hook.result.current.onConflict(); });
  await vi.waitFor(() => expect(pushToast).toHaveBeenCalled());
  expect(replaceDocument).toHaveBeenCalledTimes(1);
});

it('ignores a malformed holder event', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { hook, fire } = setup({ fetchCurrent: async () => ({ document: local, revision: 0, holder: null }) });
  act(() => fire('holder', { data: '{not json' }));
  act(() => fire('holder', { data: '{"label":5}' }));
  expect(hook.result.current.holder).toBeNull();
  act(() => fire('holder', { data: '{"label":"Codex"}' }));
  expect(hook.result.current.holder).toBe('Codex');
  warn.mockRestore();
});

const EVENT = {
  type: 'thread', documentId: 'd1', pageId: 'p', threadId: 't', threadNumber: 1, commentId: 'm', nodeId: null, nodeLabel: null,
  kind: 'new_thread', author: 'Ana', body: 'hi',
} as const;

it('sends comments to the service while mounted, reads a 409 as no holder, and stops on unmount', async () => {
  const postComment = vi.fn(async () => false);
  const { hook } = setup({ fetchCurrent: async () => ({ document: local, revision: 0, holder: null }), repository: { postComment } });
  await expect(deliverThreadEvent(EVENT)).resolves.toBe('no-holder');
  postComment.mockResolvedValueOnce(true);
  await expect(deliverThreadEvent(EVENT)).resolves.toBe('sent');
  expect(postComment).toHaveBeenCalledWith('d1', EVENT);
  hook.unmount();
  await expect(deliverThreadEvent(EVENT)).resolves.toBe('failed');
  setThreadEventSender(null);
});

it('Disconnect releases the holder, and a failure says so and keeps the badge', async () => {
  const disconnect = vi.fn(async () => undefined);
  const { hook, pushToast, fire } = setup({ fetchCurrent: async () => ({ document: local, revision: 0, holder: null }), repository: { disconnect } });
  act(() => fire('holder', { data: '{"label":"Claude Code · hyper"}' }));
  expect(hook.result.current.holder).toBe('Claude Code · hyper');
  disconnect.mockRejectedValueOnce(new Error('service down'));
  await act(async () => { await hook.result.current.disconnect(); });
  expect(hook.result.current.holder).toBe('Claude Code · hyper');
  expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Couldn’t disconnect', description: 'service down' }));
  await act(async () => { await hook.result.current.disconnect(); });
  expect(disconnect).toHaveBeenCalledWith('d1');
  expect(hook.result.current.holder).toBeNull();
});
