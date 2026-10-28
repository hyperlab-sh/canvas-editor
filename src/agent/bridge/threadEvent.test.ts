import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverThreadEvent, NoHolderError, setThreadEventSender } from './threadEvent';
import { bridgeUrls, isBridgeThreadEvent, type BridgeThreadEvent } from './protocol';

const EVENT: BridgeThreadEvent = {
  type: 'thread', documentId: 'd', pageId: 'p', threadId: 't', threadNumber: 1, commentId: 'm', nodeId: null, nodeLabel: null,
  kind: 'reply', author: 'Ana', body: 'hi',
};

afterEach(() => setThreadEventSender(null));

describe('deliverThreadEvent', () => {
  it('does nothing and reports failed while the editor is not connected', async () => {
    await expect(deliverThreadEvent(EVENT)).resolves.toBe('failed');
  });

  it('sends through the connection when there is one, and never throws when it fails', async () => {
    const send = vi.fn(async () => undefined);
    setThreadEventSender(send);
    await expect(deliverThreadEvent(EVENT)).resolves.toBe('sent');
    expect(send).toHaveBeenCalledWith(EVENT);
    setThreadEventSender(async () => { throw new Error('not delivered'); });
    await expect(deliverThreadEvent(EVENT)).resolves.toBe('failed');
  });

  it('tells nobody-holds-it apart from any other failure', async () => {
    await expect(deliverThreadEvent(EVENT)).resolves.toBe('failed');
    setThreadEventSender(async () => { throw new NoHolderError(); });
    await expect(deliverThreadEvent(EVENT)).resolves.toBe('no-holder');
    setThreadEventSender(async () => { throw new Error('down'); });
    await expect(deliverThreadEvent(EVENT)).resolves.toBe('failed');
    setThreadEventSender(async () => undefined);
    await expect(deliverThreadEvent(EVENT)).resolves.toBe('sent');
  });
});

describe('isBridgeThreadEvent', () => {
  it('accepts a whole event and refuses anything less', () => {
    expect(isBridgeThreadEvent(EVENT)).toBe(true);
    expect(isBridgeThreadEvent({ ...EVENT, nodeId: 'n', nodeLabel: 'API', kind: 'new_thread' })).toBe(true);
    expect(isBridgeThreadEvent({ ...EVENT, kind: 'edit' })).toBe(false);
    expect(isBridgeThreadEvent({ ...EVENT, body: undefined })).toBe(false);
    expect(isBridgeThreadEvent({ ...EVENT, threadNumber: undefined })).toBe(false);
    expect(isBridgeThreadEvent({ ...EVENT, threadNumber: 0 })).toBe(false);
    expect(isBridgeThreadEvent({ ...EVENT, nodeId: undefined })).toBe(false);
    expect(isBridgeThreadEvent(null)).toBe(false);
  });

  it('has its own route', () => {
    expect(bridgeUrls(1234).event).toBe('http://127.0.0.1:1234/event');
  });
});
