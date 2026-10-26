import { afterEach, describe, expect, it, vi } from 'vitest';
import { postCommentEvent, setCommentEventSender } from './commentEvent';
import { bridgeUrls, isBridgeCommentEvent, type BridgeCommentEvent } from './protocol';

const EVENT: BridgeCommentEvent = {
  type: 'comment', documentId: 'd', pageId: 'p', threadId: 't', messageId: 'm', nodeId: null, nodeLabel: null,
  kind: 'reply', author: 'Ana', body: 'hi',
};

afterEach(() => setCommentEventSender(null));

describe('postCommentEvent', () => {
  it('does nothing and reports false while the editor is not connected', async () => {
    await expect(postCommentEvent(EVENT)).resolves.toBe(false);
  });

  it('sends through the connection when there is one, and never throws when it fails', async () => {
    const send = vi.fn(async () => undefined);
    setCommentEventSender(send);
    await expect(postCommentEvent(EVENT)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(EVENT);
    setCommentEventSender(async () => { throw new Error('not delivered'); });
    await expect(postCommentEvent(EVENT)).resolves.toBe(false);
  });
});

describe('isBridgeCommentEvent', () => {
  it('accepts a whole event and refuses anything less', () => {
    expect(isBridgeCommentEvent(EVENT)).toBe(true);
    expect(isBridgeCommentEvent({ ...EVENT, nodeId: 'n', nodeLabel: 'API', kind: 'new_thread' })).toBe(true);
    expect(isBridgeCommentEvent({ ...EVENT, kind: 'edit' })).toBe(false);
    expect(isBridgeCommentEvent({ ...EVENT, body: undefined })).toBe(false);
    expect(isBridgeCommentEvent({ ...EVENT, nodeId: undefined })).toBe(false);
    expect(isBridgeCommentEvent(null)).toBe(false);
  });

  it('has its own route', () => {
    expect(bridgeUrls(1234).event).toBe('http://127.0.0.1:1234/event');
  });
});
