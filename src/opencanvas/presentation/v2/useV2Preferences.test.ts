import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpConfig } from './V2AgentConnect';
import { readPreferences } from './useV2Preferences';

describe('bridge token', () => {
  beforeEach(() => localStorage.clear());

  it('is made once, kept, and never replaces one the user set', () => {
    const first = readPreferences().bridgeToken;
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(readPreferences().bridgeToken).toBe(first);
    localStorage.setItem('openflowkit-v2-preferences', JSON.stringify({ bridgeToken: 'mine' }));
    expect(readPreferences().bridgeToken).toBe('mine');
  });

  it('keeps the stored preferences when saving the new token fails', () => {
    localStorage.setItem('openflowkit-v2-preferences', JSON.stringify({ theme: 'dark' }));
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const preferences = readPreferences();
    setItem.mockRestore();
    expect(preferences.theme).toBe('dark');
    expect(preferences.bridgeToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('goes into the MCP config next to a custom port', () => {
    expect(JSON.parse(mcpConfig(43119, 'abc')).mcpServers.openflowkit.env).toEqual({ OPENFLOWKIT_BRIDGE_TOKEN: 'abc' });
    expect(JSON.parse(mcpConfig(5000, 'abc')).mcpServers.openflowkit.env).toEqual({ OPENFLOWKIT_BRIDGE_PORT: '5000', OPENFLOWKIT_BRIDGE_TOKEN: 'abc' });
    expect(JSON.parse(mcpConfig(43119, '')).mcpServers.openflowkit.env).toBeUndefined();
  });
});

describe('comment preferences', () => {
  beforeEach(() => localStorage.clear());
  const store = (value: unknown) => localStorage.setItem('openflowkit-v2-preferences', JSON.stringify(value));

  it('default to live comments off', () => {
    expect(readPreferences()).toMatchObject({ liveComments: false });
  });

  it('keep only a literal true for live comments', () => {
    store({ liveComments: true });
    expect(readPreferences()).toMatchObject({ liveComments: true });
    store({ liveComments: 'yes' });
    expect(readPreferences()).toMatchObject({ liveComments: false });
  });

  it('ignore a displayName stored by an earlier version', () => {
    store({ displayName: 'Ada', liveComments: true });
    const loaded = readPreferences();
    expect(loaded).toMatchObject({ liveComments: true });
    expect(loaded).not.toHaveProperty('displayName');
  });
});

describe('threads panel preferences', () => {
  beforeEach(() => localStorage.clear());
  const store = (value: unknown) => localStorage.setItem('openflowkit-v2-preferences', JSON.stringify(value));

  it('default to resolved hidden, unanswered-only off and nothing read', () => {
    expect(readPreferences()).toMatchObject({ threadsShowResolved: false, threadsUnansweredOnly: false, threadReads: {}, threadSent: [] });
  });

  it('keep only a literal true for the toggles', () => {
    store({ threadsShowResolved: true, threadsUnansweredOnly: 'yes' });
    expect(readPreferences()).toMatchObject({ threadsShowResolved: true, threadsUnansweredOnly: false });
  });

  it('keep well-formed read marks and drop the rest', () => {
    store({ threadReads: { 'd:t': '2026-10-26T12:00:00.000Z', 'd:u': 'unread', 'd:bad': 'x', 'd:n': 3 } });
    expect(readPreferences().threadReads).toEqual({ 'd:t': '2026-10-26T12:00:00.000Z', 'd:u': 'unread' });
    store({ threadReads: 'nope' });
    expect(readPreferences().threadReads).toEqual({});
  });
});
