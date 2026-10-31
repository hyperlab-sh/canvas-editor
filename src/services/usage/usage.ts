// Usage counts: a fixed list of events counted in memory, sent as one small beacon to the share Worker.
// Nothing here may ever throw into the app or wait on the network: every storage touch and send is guarded.
import { SHARE_ORIGIN } from '../share/origin';
import type { UsageBeacon, UsageEntry, UsageEvent } from './usageEvents';

/** package.json's version, injected by vite.config.ts. */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? '0.0.0';

const SWITCH_KEY = 'ofk.usage';
const ID_KEY = 'ofk.usage.id';
const FIRST_SEEN_KEY = 'ofk.usage.firstSeen';
/** A hidden tab sends at most this often; pagehide always sends. Beacons share the Worker's daily request cap with share links. */
const HIDDEN_SEND_GAP_MS = 5 * 60_000;
const APP_ERROR_CAP = 50;
const TICK_S = 5;
/** Input within this long counts the visible tab as engaged. */
const ENGAGED_MS = 60_000;

const BUCKETS: readonly (readonly [RegExp, string])[] = [
  [/^news\.ycombinator\.com$/, 'hn'],
  [/(^|\.)producthunt\.com$/, 'producthunt'],
  [/^(t\.co|(.+\.)?x\.com|(.+\.)?twitter\.com)$/, 'x'],
  [/(^|\.)reddit\.com$/, 'reddit'],
  [/(^|\.)github\.com$/, 'github'],
  [/(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/, 'google'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, 'linkedin'],
];

/** Where a visit came from: utm_source, else the referrer's bucket, else 'direct' (no referrer, or this site). */
export function sourceOf(search: string, referrer: string, ownHost: string): string {
  const utm = (new URLSearchParams(search).get('utm_source') ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
  if (utm) return utm;
  let host = '';
  try { host = new URL(referrer).hostname.toLowerCase(); } catch { return 'direct'; }
  if (!host || host === ownHost.toLowerCase().split(':')[0]) return 'direct';
  return BUCKETS.find(([pattern]) => pattern.test(host))?.[1] ?? 'other';
}

/** The route a visit landed on. The bare root opens the last diagram, but it is the app's front door. */
export function entryOf(hash: string): UsageEntry {
  if (/^#\/s\//.test(hash)) return 'shared';
  if (/^#\/(map|from)\/github\//.test(hash)) return 'map';
  if (/^#\/(d|v2|flow|from)\//.test(hash)) return 'doc';
  return 'home';
}

/** The read-only viewer of a share link: nothing is sent from it. */
export const isViewerRoute = (hash: string): boolean => /^#\/s\//.test(hash);

export interface UsageEnvironment {
  /** localStorage `ofk.usage`: 'off' (Settings), 'on' (opts a dev build in, for e2e), or null. */
  readonly switch: string | null;
  readonly storage: boolean;
  readonly gpc: boolean;
  readonly dnt: string | null | undefined;
  readonly dev: boolean;
  /** VITE_USAGE=on: a dev build that counts. */
  readonly devOptIn: boolean;
}

/** Counting is on unless the person, their browser, blocked storage or a dev build says otherwise. */
export function usageAllowed(env: UsageEnvironment): boolean {
  return env.storage && env.switch !== 'off' && !env.gpc && env.dnt !== '1' && (!env.dev || env.devOptIn || env.switch === 'on');
}

interface Install { readonly uid: string; readonly firstSeen: string; readonly returning: boolean }

const randomId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** This browser's random id and first UTC day, made on first use; null where storage refuses. */
export function ensureInstall(storage: Storage, now: Date, mint: () => string = randomId): Install | null {
  try {
    const uid = storage.getItem(ID_KEY);
    const firstSeen = storage.getItem(FIRST_SEEN_KEY);
    if (uid && /^[0-9a-f]{32}$/.test(uid) && firstSeen && /^\d{4}-\d{2}-\d{2}$/.test(firstSeen)) return { uid, firstSeen, returning: true };
    const fresh = { uid: mint(), firstSeen: now.toISOString().slice(0, 10), returning: false };
    storage.setItem(ID_KEY, fresh.uid);
    storage.setItem(FIRST_SEEN_KEY, fresh.firstSeen);
    return fresh;
  } catch { return null; }
}

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function readSwitch(): { switch: string | null; storage: boolean } {
  try { return { switch: window.localStorage.getItem(SWITCH_KEY), storage: true }; } catch { return { switch: null, storage: false }; }
}

function enabled(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return usageAllowed({
    ...readSwitch(), gpc: nav.globalPrivacyControl === true, dnt: nav.doNotTrack,
    dev: import.meta.env.DEV, devOptIn: import.meta.env.VITE_USAGE === 'on',
  });
}

type Listener = (event: UsageEvent) => void;
const listeners = new Set<Listener>();
let counts: Partial<Record<UsageEvent, number>> = {};
let context: { source: string; entry: UsageEntry } | null = null;
let install: Install | null = null;
const once = new Set<UsageEvent>();
let lastSent = 0;
let lastInput = 0;
let stop: (() => void) | null = null;

function count(event: UsageEvent, by = 1): void {
  if (!enabled()) return;
  const next = (counts[event] ?? 0) + by;
  counts[event] = event === 'app_error' ? Math.min(next, APP_ERROR_CAP) : next;
}

/** One event. Listeners (the feedback prompts) hear it even when counting is off. */
export function track(event: UsageEvent): void {
  count(event);
  for (const listener of listeners) {
    try { listener(event); } catch { /* a listener never breaks the action it heard */ }
  }
}

/** Once per page load: the first agent connection, the first WebMCP call. */
export function trackOnce(event: UsageEvent): void {
  if (once.has(event)) return;
  once.add(event);
  track(event);
}

export function onTrack(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Sends what was counted since the last send; nothing when empty, off, or on the share viewer (held for later). */
export function flushUsage(now = Date.now()): void {
  if (!context) return;
  if (!enabled()) { counts = {}; return; }
  if (isViewerRoute(window.location.hash)) return;
  const sent = Object.fromEntries(Object.entries(counts).filter(([, value]) => (value ?? 0) > 0)) as UsageBeacon['counts'];
  if (Object.keys(sent).length === 0) return;
  const store = storage();
  install ??= store ? ensureInstall(store, new Date(now)) : null;
  if (!install) return;
  const body: UsageBeacon = { v: 1, uid: install.uid, firstSeen: install.firstSeen, ...context, version: APP_VERSION, returning: install.returning, counts: sent };
  let queued = false;
  try { queued = navigator.sendBeacon(`${SHARE_ORIGIN}/e`, JSON.stringify(body)); } catch { /* blocked: keep the counts */ }
  if (!queued) return;
  counts = {};
  lastSent = now;
}

/** Whether Settings shows stats on (the person's choice; browser signals are not shown as a switch). */
export function usageSwitchOn(): boolean {
  return readSwitch().switch !== 'off';
}

/** Settings: off forgets this browser's id and what was counted; on again starts a fresh id. */
export function setUsageSwitch(on: boolean): void {
  const store = storage();
  try {
    if (on) store?.removeItem(SWITCH_KEY);
    else {
      store?.setItem(SWITCH_KEY, 'off');
      store?.removeItem(ID_KEY);
      store?.removeItem(FIRST_SEEN_KEY);
    }
  } catch { /* storage refused: counting stays off anyway */ }
  counts = {};
  install = null;
}

/** Once at boot. */
export function startUsage({ entry }: { readonly entry: UsageEntry }): void {
  if (context) return;
  context = { source: sourceOf(window.location.search, document.referrer, window.location.host), entry };
  const store = storage();
  if (enabled() && store) install = ensureInstall(store, new Date());
  count('session');
  const onHidden = () => { if (document.visibilityState === 'hidden' && Date.now() - lastSent >= HIDDEN_SEND_GAP_MS) flushUsage(); };
  const onPageHide = () => flushUsage();
  const onError = () => count('app_error');
  const onInput = () => { lastInput = Date.now(); };
  // Engaged time: a visible tab with input in the last minute. The tick stops while the tab is hidden.
  let timer = 0;
  const tick = () => { if (Date.now() - lastInput < ENGAGED_MS) count('active_seconds', TICK_S); };
  const pace = () => {
    window.clearInterval(timer);
    if (document.visibilityState === 'visible') timer = window.setInterval(tick, TICK_S * 1000);
  };
  const inputs = ['pointerdown', 'keydown', 'wheel'] as const;
  document.addEventListener('visibilitychange', onHidden);
  document.addEventListener('visibilitychange', pace);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onError);
  for (const name of inputs) window.addEventListener(name, onInput, { capture: true, passive: true });
  pace();
  stop = () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onHidden);
    document.removeEventListener('visibilitychange', pace);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onError);
    for (const name of inputs) window.removeEventListener(name, onInput, { capture: true });
  };
}

/** Test seam: a fresh page load. */
export function resetUsageForTest(): void {
  stop?.();
  stop = null;
  context = null;
  install = null;
  counts = {};
  once.clear();
  listeners.clear();
  lastSent = 0;
  lastInput = 0;
}

/** Test seam: what would be sent now. */
export const pendingUsage = (): Partial<Record<UsageEvent, number>> => ({ ...counts });
