import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_VERSION, ensureInstall, entryOf, flushUsage, onTrack, pendingUsage, resetUsageForTest, setUsageSwitch, sourceOf,
  startUsage, track, trackOnce, usageAllowed, usageSwitchOn, type UsageEnvironment,
} from './usage';
import type { UsageBeacon } from './usageEvents';

describe('sourceOf', () => {
  const own = 'app.openflowkit.com';
  it.each([
    ['https://news.ycombinator.com/item?id=1', 'hn'],
    ['https://www.producthunt.com/posts/x', 'producthunt'],
    ['https://t.co/abc', 'x'],
    ['https://x.com/someone', 'x'],
    ['https://mobile.twitter.com/', 'x'],
    ['https://old.reddit.com/r/programming', 'reddit'],
    ['https://github.com/openflowkit/openflowkit', 'github'],
    ['https://www.google.com/', 'google'],
    ['https://www.google.co.uk/', 'google'],
    ['https://www.linkedin.com/feed', 'linkedin'],
    ['https://lnkd.in/xyz', 'linkedin'],
    ['https://example.org/blog', 'other'],
    ['https://notgithub.com/', 'other'],
    ['https://app.openflowkit.com/#/home', 'direct'],
    ['', 'direct'],
  ])('%s → %s', (referrer, expected) => {
    expect(sourceOf('', referrer, own)).toBe(expected);
  });

  it('utm_source wins over the referrer, cleaned and capped', () => {
    expect(sourceOf('?utm_source=Newsletter', 'https://github.com/', own)).toBe('newsletter');
    expect(sourceOf('?utm_source=%3Cscript%3E', '', own)).toBe('script');
    expect(sourceOf(`?utm_source=${'a'.repeat(80)}`, '', own)).toHaveLength(32);
    expect(sourceOf('?utm_source=%20', 'https://github.com/', own)).toBe('github');
  });
});

describe('entryOf', () => {
  it.each([
    ['', 'home'], ['#/', 'home'], ['#/home', 'home'], ['#/d/doc-1', 'doc'], ['#/s/abc/key', 'shared'],
    ['#/map/github/o/r', 'map'], ['#/from/github/o/r', 'map'], ['#/from/dsl?d=x', 'doc'],
  ] as const)('%s → %s', (hash, entry) => expect(entryOf(hash)).toBe(entry));
});

describe('usageAllowed', () => {
  const base: UsageEnvironment = { switch: null, storage: true, gpc: false, dnt: null, dev: false, devOptIn: false };
  it('is on by default in a production build', () => expect(usageAllowed(base)).toBe(true));
  it.each([
    ['the Settings switch', { switch: 'off' }],
    ['Global Privacy Control', { gpc: true }],
    ['Do Not Track', { dnt: '1' }],
    ['blocked storage', { storage: false }],
    ['a dev build', { dev: true }],
  ] as const)('is off for %s', (_, patch) => expect(usageAllowed({ ...base, ...patch })).toBe(false));
  it('a dev build counts when opted in by env or by the e2e switch', () => {
    expect(usageAllowed({ ...base, dev: true, devOptIn: true })).toBe(true);
    expect(usageAllowed({ ...base, dev: true, switch: 'on' })).toBe(true);
    expect(usageAllowed({ ...base, dev: true, switch: 'on', gpc: true })).toBe(false);
  });
});

describe('ensureInstall', () => {
  it('mints an id and the UTC day once, then reads them back as returning', () => {
    const now = new Date('2026-10-11T23:30:00-05:00');
    const first = ensureInstall(localStorage, now, () => 'a'.repeat(32));
    expect(first).toEqual({ uid: 'a'.repeat(32), firstSeen: '2026-10-12', returning: false });
    expect(ensureInstall(localStorage, new Date(), () => 'b'.repeat(32))).toEqual({ ...first, returning: true });
  });
  it('a malformed id starts over', () => {
    localStorage.setItem('ofk.usage.id', 'nope');
    localStorage.setItem('ofk.usage.firstSeen', '2026-01-01');
    expect(ensureInstall(localStorage, new Date('2026-10-11T00:00:00Z'), () => 'c'.repeat(32))?.returning).toBe(false);
  });
  it('storage that throws gives null, never an exception', () => {
    const blocked = { getItem: () => { throw new DOMException('denied', 'SecurityError'); } } as unknown as Storage;
    expect(ensureInstall(blocked, new Date())).toBeNull();
  });
});

describe('counter and beacon', () => {
  const beacon = vi.fn<(url: string, body: string) => boolean>(() => true);
  const sent = (call = 0) => JSON.parse(beacon.mock.calls[call]![1]) as UsageBeacon;
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('ofk.usage', 'on'); // the test build is a dev build
    window.location.hash = '#/d/doc-1';
    beacon.mockClear();
    beacon.mockReturnValue(true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
  });
  afterEach(() => resetUsageForTest());

  it('sends the session and non-zero counts once, then only what came after', () => {
    startUsage({ entry: 'doc' });
    track('export_image');
    track('export_image');
    flushUsage();
    expect(beacon).toHaveBeenCalledOnce();
    expect(beacon.mock.calls[0]![0]).toBe('https://share.openflowkit.com/e');
    const body = sent();
    expect(body).toMatchObject({ v: 1, entry: 'doc', version: APP_VERSION, returning: false, counts: { session: 1, export_image: 2 } });
    expect(body.uid).toMatch(/^[0-9a-f]{32}$/);
    expect(body.firstSeen).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    flushUsage();
    expect(beacon).toHaveBeenCalledOnce(); // nothing new: no empty beacon
    track('code_opened');
    flushUsage();
    expect(sent(1).counts).toEqual({ code_opened: 1 });
    expect(sent(1).uid).toBe(body.uid);
  });

  it('pagehide always sends; a hidden tab sends at most once per 5 minutes', () => {
    startUsage({ entry: 'doc' });
    const hide = () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    hide();
    expect(beacon).toHaveBeenCalledOnce();
    track('export_data');
    hide();
    expect(beacon).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('keeps the counts when the beacon is refused, and never throws when it is blocked', () => {
    startUsage({ entry: 'doc' });
    beacon.mockReturnValue(false);
    flushUsage();
    expect(pendingUsage()).toEqual({ session: 1 });
    beacon.mockImplementation(() => { throw new TypeError('blocked'); });
    expect(() => flushUsage()).not.toThrow();
    expect(pendingUsage()).toEqual({ session: 1 });
  });

  it('turning stats off drops the counts and the id; on again starts a fresh id', () => {
    startUsage({ entry: 'home' });
    flushUsage();
    const first = sent().uid;
    track('export_image');
    setUsageSwitch(false);
    expect(usageSwitchOn()).toBe(false);
    expect(localStorage.getItem('ofk.usage.id')).toBeNull();
    track('export_image');
    flushUsage();
    expect(beacon).toHaveBeenCalledOnce();
    setUsageSwitch(true);
    localStorage.setItem('ofk.usage', 'on');
    track('export_image');
    flushUsage();
    expect(sent(1).counts).toEqual({ export_image: 1 });
    expect(sent(1).uid).not.toBe(first);
    expect(sent(1).returning).toBe(false);
  });

  it('the shared viewer holds its counts; a visit that leaves it sends them', () => {
    window.location.hash = '#/s/abc/key';
    startUsage({ entry: 'shared' });
    track('shared_copied');
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon).not.toHaveBeenCalled();
    window.location.hash = '#/d/copy';
    flushUsage();
    expect(sent()).toMatchObject({ entry: 'shared', counts: { session: 1, shared_copied: 1 } });
  });

  it('listeners hear events even with counting off; trackOnce counts once a load', () => {
    localStorage.setItem('ofk.usage', 'off');
    startUsage({ entry: 'doc' });
    const heard: string[] = [];
    const stop = onTrack((event) => heard.push(event));
    track('ai_applied');
    trackOnce('agent_mcp');
    trackOnce('agent_mcp');
    stop();
    track('ai_applied');
    expect(heard).toEqual(['ai_applied', 'agent_mcp']);
    expect(pendingUsage()).toEqual({});
  });

  it('counts page errors, capped at 50 a beacon', () => {
    startUsage({ entry: 'doc' });
    for (let i = 0; i < 60; i += 1) window.dispatchEvent(new Event('error'));
    expect(pendingUsage().app_error).toBe(50);
  });

  it('counts engaged seconds only with recent input on a visible tab', () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      startUsage({ entry: 'doc' });
      vi.advanceTimersByTime(10_000);
      expect(pendingUsage().active_seconds).toBeUndefined();
      window.dispatchEvent(new Event('keydown'));
      vi.advanceTimersByTime(10_000);
      expect(pendingUsage().active_seconds).toBe(10);
      vi.advanceTimersByTime(120_000);
      expect(pendingUsage().active_seconds).toBe(55); // ticks until a minute after the input
    } finally { vi.useRealTimers(); }
  });
});
