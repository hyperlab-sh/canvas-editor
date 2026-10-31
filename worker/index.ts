// Share-link store: an encrypted blob in R2 under a random id. The Worker never sees a key or a
// plaintext (the key lives in the link's #fragment, which browsers do not send).
//   POST   /s      body = ciphertext, X-Turnstile-Token header → 201 { id, deleteToken }
//   GET    /s/:id  → the ciphertext, 404 when unknown or deleted
//   DELETE /s/:id  Authorization: Bearer <deleteToken> → 204
//   POST   /e      usage beacon (text/plain JSON UsageBeacon) → 204; one D1 `sessions` row, install id kept only as an HMAC
//   POST   /feedback  JSON FeedbackBody (X-Turnstile-Token when it carries text or email) → 201 { ok }; one D1 row
// A Quota Durable Object keeps R2 inside its free tier: POST answers 507 once stored bytes or this
// month's uploads reach the cap. Reads need no cap while the account is on Workers Free (below).
// Types are the minimum this file uses from Workers; no @cloudflare/workers-types dependency.

import {
  FEEDBACK_FEATURES, MAX_PRO_PRICE, PAY_OPTIONS, PRO_PLANS, USAGE_ENTRIES, USAGE_EVENTS,
  type FeedbackFeature, type PayOption, type ProPlan, type UsageEntry, type UsageEvent,
} from '../src/services/usage/usageEvents';

export interface R2ObjectLike {
  readonly size: number;
  readonly customMetadata?: Record<string, string>;
}
export interface R2ObjectBodyLike extends R2ObjectLike {
  readonly body: ReadableStream<Uint8Array>;
}
export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
}
export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
/** The Durable Object namespace binding, as far as this file calls it. */
export interface QuotaNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface D1DatabaseLike {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
  /** One transaction; only the nightly fold needs it. */
  batch?(statements: unknown[]): Promise<unknown>;
}
export interface Env {
  SHARES: R2BucketLike;
  QUOTA: QuotaNamespaceLike;
  TURNSTILE_SECRET: string;
  /** Cloudflare Rate Limiting binding; absent means no limit (local dev). */
  RATE_LIMITER?: RateLimiterLike;
  /** Looser per-IP limit for usage beacons and feedback (many people can share one office IP); absent: no limit. */
  EVENT_LIMITER?: RateLimiterLike;
  /** Comma-separated app origins allowed by CORS. Default: https://app.openflowkit.com. localhost and 127.0.0.1 are always allowed (dev). */
  ALLOWED_ORIGINS?: string;
  /** D1 with the `sessions` and `feedback` tables (migrations/). Absent: /e drops beacons, /feedback answers 503. */
  DB?: D1DatabaseLike;
  /** Secret HMAC key that turns an install id into the stored `user`; absent means /e drops beacons (local dev). */
  USAGE_SALT?: string;
}

export const MAX_BODY_BYTES = 1_048_576;
const MAX_BEACON_BYTES = 4_096;
const MAX_FEEDBACK_BYTES = 8_192;
const MAX_COUNT = 1_000;
const MAX_ACTIVE_SECONDS = 86_400;
// Before launch: an older first-seen day is a bad clock or a forged beacon.
const FIRST_DAY = '2026-01-01';
// R2's free tier is 10 GB stored, 1M Class A (uploads) and 10M Class B (reads) a month; stop short of both.
// ponytail: reads are capped by Workers Free itself (100k requests a day ≈ 3.1M a month); on Workers Paid,
// count GETs here too.
export const QUOTA_LIMITS = { storedBytes: 8_000_000_000, uploadsPerMonth: 900_000 };
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const ID_PATTERN = /^\/s\/([0-9a-f]{32})$/;
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const DEFAULT_ORIGINS = 'https://app.openflowkit.com';
// The browser's envelope (src/services/share/shareCrypto.ts): version byte 1, 12-byte IV, ciphertext + 16-byte tag.
const ENVELOPE_VERSION = 1;
const MIN_ENVELOPE_BYTES = 1 + 12 + 16;

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const randomHex = (bytes: number): string => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256Hex = async (text: string): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

/** Equal-length strings only (both are SHA-256 hex); no early exit on the first difference. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(',').map((entry) => entry.trim());
  if (!origin || !(DEV_ORIGIN.test(origin) || allowed.includes(origin))) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Turnstile-Token, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Reads at most `limit` bytes; null when the body is larger (chunked uploads have no Content-Length to trust). */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

async function turnstilePasses(token: string, ip: string, env: Env, fetcher: typeof fetch): Promise<boolean | 'unavailable'> {
  try {
    const response = await fetcher(SITEVERIFY, {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    const result = await response.json() as { success?: boolean };
    return result.success === true;
  } catch {
    return 'unavailable';
  }
}

async function create(request: Request, env: Env, fetcher: typeof fetch): Promise<Response> {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) return json(413, { error: 'too-large' });
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  // ponytail: Cloudflare's binding counts per colo and is eventually consistent, so the ceiling is
  // per-location and soft — enough to stop a script, not a distributed flood. Upgrade: a Durable Object counter.
  if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({ key: ip })).success) return json(429, { error: 'rate-limited' });
  const verdict = await turnstilePasses(request.headers.get('X-Turnstile-Token') ?? '', ip, env, fetcher);
  if (verdict === 'unavailable') return json(503, { error: 'turnstile-unavailable' });
  if (!verdict) return json(403, { error: 'turnstile-failed' });
  const body = await readCapped(request, MAX_BODY_BYTES);
  if (!body) return json(413, { error: 'too-large' });
  // Only our own envelope is stored: this is not general file hosting.
  if (body.length < MIN_ENVELOPE_BYTES || body[0] !== ENVELOPE_VERSION) return json(400, { error: 'not-an-envelope' });
  if ((await quota(env, 'reserve', body.length)).status !== 204) return json(507, { error: 'storage-full' });
  const id = randomHex(16);
  const deleteToken = randomHex(32);
  try {
    await env.SHARES.put(id, body, { customMetadata: { deleteHash: await sha256Hex(deleteToken) } });
  } catch (error) {
    await quota(env, 'release', body.length);
    throw error;
  }
  return json(201, { id, deleteToken });
}

async function read(id: string, env: Env): Promise<Response> {
  const object = await env.SHARES.get(id);
  if (!object) return json(404, { error: 'not-found' });
  // no-store: a deleted link must stop opening, not linger in a cache.
  // Opaque bytes, never a page: nosniff + attachment + a sandboxing CSP keep a browser from rendering them.
  return new Response(object.body, { headers: {
    'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'attachment', 'Content-Security-Policy': "sandbox; default-src 'none'",
  } });
}

async function remove(id: string, request: Request, env: Env): Promise<Response> {
  const object = await env.SHARES.head(id);
  if (!object) return json(404, { error: 'not-found' });
  const token = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
  const matches = constantTimeEqual(await sha256Hex(token), object.customMetadata?.deleteHash ?? '');
  if (!matches) return json(403, { error: 'bad-delete-token' });
  await env.SHARES.delete(id);
  await quota(env, 'release', object.size);
  return new Response(null, { status: 204 });
}

const country = (request: Request): string => (request as Request & { cf?: { country?: string } }).cf?.country ?? 'XX';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T);
/** Lowercase slug for a D1 column; anything outside [a-z0-9._-] becomes 'other'. */
const slug = (value: string, max: number): string => {
  const cleaned = value.trim().toLowerCase().slice(0, max);
  return /^[a-z0-9._-]+$/.test(cleaned) ? cleaned : 'other';
};

async function readJson(request: Request, limit: number): Promise<unknown | 'too-large'> {
  if (Number(request.headers.get('Content-Length') ?? 0) > limit) return 'too-large';
  const body = await readCapped(request, limit);
  if (!body) return 'too-large';
  try { return JSON.parse(new TextDecoder().decode(body)); } catch { return undefined; }
}

async function rateLimited(env: Env, key: string): Promise<boolean> {
  return !!env.EVENT_LIMITER && !(await env.EVENT_LIMITER.limit({ key })).success;
}

type Beacon = {
  uid: string; firstSeen: string; source: string; entry: UsageEntry; version: string; returning: boolean;
  counts: Record<UsageEvent, number>;
};
const UID = /^[0-9a-f]{32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day between launch and today, else today. */
const cohortDay = (value: unknown, today: string): string =>
  typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().startsWith(value) && value >= FIRST_DAY && value <= today ? value : today;

function parseBeacon(value: unknown, today: string): Beacon | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.uid !== 'string' || !UID.test(value.uid)) return null;
  if (!oneOf(USAGE_ENTRIES, value.entry) || typeof value.returning !== 'boolean') return null;
  if (typeof value.source !== 'string' || typeof value.version !== 'string' || !isRecord(value.counts)) return null;
  const given = value.counts;
  const counts = Object.fromEntries(USAGE_EVENTS.map((event) => {
    const count = given[event];
    const max = event === 'active_seconds' ? MAX_ACTIVE_SECONDS : MAX_COUNT;
    return [event, typeof count === 'number' && Number.isFinite(count) ? Math.min(max, Math.max(0, Math.trunc(count))) : 0];
  })) as Record<UsageEvent, number>;
  return {
    uid: value.uid, firstSeen: cohortDay(value.firstSeen, today), source: slug(value.source, 40), entry: value.entry,
    version: slug(value.version, 20), returning: value.returning, counts,
  };
}

/** The install id, keyed: stable across days (MAU, retention) but not reversible to the id on the device. */
async function userKey(salt: string, uid: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(uid)))).slice(0, 32);
}

// Quoted: `returning` is an SQLite keyword. Event columns come from the contract, so code and table can't drift
// (index.test.ts checks the migration declares each one).
const SESSION_COLUMNS = ['received_at', 'day', 'user', 'first_seen', 'source', 'entry', 'version', 'returning', 'country', ...USAGE_EVENTS, 'beacons'];
const insert = (table: string, columns: readonly string[]): string =>
  `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
/**
 * One row per person per day (migration 0004): a later beacon adds its counts and leaves the day's first source,
 * entry, version and country. Only counters change on a repeat, so it writes the row and no index entries, which
 * keeps D1 inside the Workers Paid allowance (50M rows written, 5 GB) at 100k people a day.
 */
export const INSERT_SESSION = `${insert('sessions', SESSION_COLUMNS)} ON CONFLICT (user, day) DO UPDATE SET ${
  [...USAGE_EVENTS, 'beacons'].map((column) => `"${column}" = "${column}" + excluded."${column}"`).join(', ')}`;

/** Days of per-person rows kept: every stats range (90 days) and retention window (day 30, week 4 of a 6-week cohort) fits. */
export const KEEP_USAGE_DAYS = 100;
/**
 * The nightly cron: each day past the window becomes one `usage_daily` row (people, new people, every event total),
 * then its per-person rows go, in one transaction. Storage stops growing with time; the long-run trend stays.
 */
export async function pruneUsage(
  db: { prepare(sql: string): { bind(...values: unknown[]): unknown }; batch(statements: unknown[]): Promise<unknown> }, now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - KEEP_USAGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const totals = [...USAGE_EVENTS, 'beacons'].map((column) => `'${column}', SUM("${column}")`).join(', ');
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO usage_daily (day, people, new_people, totals)
      SELECT day, COUNT(DISTINCT user), COUNT(DISTINCT CASE WHEN first_seen = day THEN user END), json_object(${totals})
      FROM sessions WHERE day < ? GROUP BY day`).bind(cutoff),
    db.prepare('DELETE FROM sessions WHERE day < ?').bind(cutoff),
  ]);
}

async function usageBeacon(request: Request, env: Env, now: Date): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  // Own limiter and key prefix: beacons never eat the upload budget, nor feedback the beacon budget.
  if (await rateLimited(env, `e:${ip}`)) return json(429, { error: 'rate-limited' });
  const body = await readJson(request, MAX_BEACON_BYTES);
  if (body === 'too-large') return json(413, { error: 'too-large' });
  const receivedAt = now.toISOString();
  const day = receivedAt.slice(0, 10);
  const beacon = parseBeacon(body, day);
  if (!beacon) return json(400, { error: 'bad-beacon' });
  if (!env.DB || !env.USAGE_SALT) return new Response(null, { status: 204 });
  await env.DB.prepare(INSERT_SESSION).bind(
    receivedAt, day, await userKey(env.USAGE_SALT, beacon.uid), beacon.firstSeen, beacon.source, beacon.entry,
    beacon.version, beacon.returning ? 1 : 0, country(request), ...USAGE_EVENTS.map((event) => beacon.counts[event]), 1,
  ).run();
  return new Response(null, { status: 204 });
}

type Feedback = {
  kind: 'feature' | 'product' | 'general' | 'pro'; feature: FeedbackFeature | null; rating: 'up' | 'down' | null;
  pmf: 'very' | 'somewhat' | 'not' | null; pay: PayOption[] | null; plan: ProPlan | null; price: number | null;
  text: string | null; email: string | null; version: string;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INVALID = Symbol('invalid');
/** null when absent, the value when it is in the list, INVALID otherwise. */
const pick = <T extends string>(list: readonly T[], value: unknown): T | null | typeof INVALID =>
  value === undefined || value === null ? null : oneOf(list, value) ? value : INVALID;
/** Trimmed text, null when absent or blank, INVALID when not a string or longer than `max`. */
const words = (value: unknown, max: number): string | null | typeof INVALID => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > max) return INVALID;
  return value.trim() || null;
};

function parseFeedback(value: unknown): Feedback | null {
  if (!isRecord(value) || typeof value.version !== 'string' || value.version.length > 20) return null;
  const kind = pick(['feature', 'product', 'general', 'pro'] as const, value.kind);
  const feature = pick(FEEDBACK_FEATURES, value.feature);
  const rating = pick(['up', 'down'] as const, value.rating);
  const pmf = pick(['very', 'somewhat', 'not'] as const, value.pmf);
  const plan = pick(PRO_PLANS, value.plan);
  const price = value.price === undefined || value.price === null ? null
    : Number.isInteger(value.price) && (value.price as number) >= 0 && (value.price as number) <= MAX_PRO_PRICE ? value.price as number : INVALID;
  const text = words(value.text, 2_000);
  const email = words(value.email, 254);
  if (kind === null || kind === INVALID || feature === INVALID || rating === INVALID || pmf === INVALID) return null;
  if (plan === INVALID || price === INVALID) return null;
  if (text === INVALID || email === INVALID || (email !== null && !EMAIL.test(email))) return null;
  if (kind === 'feature' && feature === null) return null;
  // A waitlist entry is a plan and somewhere to say it opened; the plan fields belong to it alone.
  if (kind === 'pro' ? plan === null || email === null : plan !== null || price !== null) return null;
  if (value.pay !== undefined && !(Array.isArray(value.pay) && value.pay.every((option) => oneOf(PAY_OPTIONS, option)))) return null;
  const pay = [...new Set((value.pay ?? []) as PayOption[])];
  const parsed: Feedback = {
    kind, feature, rating, pmf, pay: pay.length ? pay : null, plan, price, text, email, version: slug(value.version, 20),
  };
  return rating || pmf || parsed.pay || text || email ? parsed : null;
}

const INSERT_FEEDBACK = insert('feedback',
  ['created_at', 'kind', 'feature', 'rating', 'pmf', 'pay', 'plan', 'price', 'text', 'email', 'version', 'country']);

async function feedback(request: Request, env: Env, fetcher: typeof fetch, now: Date): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (await rateLimited(env, `f:${ip}`)) return json(429, { error: 'rate-limited' });
  const body = await readJson(request, MAX_FEEDBACK_BYTES);
  if (body === 'too-large') return json(413, { error: 'too-large' });
  const entry = parseFeedback(body);
  if (!entry) return json(400, { error: 'bad-feedback' });
  if (!env.DB) return json(503, { error: 'feedback-unavailable' });
  // Free words or an address are what a spammer wants in; a bare thumbs or PMF answer is not worth a challenge.
  if (entry.text || entry.email) {
    const verdict = await turnstilePasses(request.headers.get('X-Turnstile-Token') ?? '', ip, env, fetcher);
    if (verdict === 'unavailable') return json(503, { error: 'turnstile-unavailable' });
    if (!verdict) return json(403, { error: 'turnstile-failed' });
  }
  await env.DB.prepare(INSERT_FEEDBACK).bind(
    now.toISOString(), entry.kind, entry.feature, entry.rating, entry.pmf, entry.pay?.join(',') ?? null, entry.plan, entry.price,
    entry.text, entry.email, entry.version, country(request),
  ).run();
  return json(201, { ok: true });
}

function quota(env: Env, action: 'reserve' | 'release', bytes: number): Promise<Response> {
  return env.QUOTA.get(env.QUOTA.idFromName('global')).fetch(`https://quota/${action}?bytes=${bytes}`);
}

type Usage = { bytes: number; month: string; uploads: number };

/** One global counter. A Durable Object runs one event at a time across its storage awaits, so reserve never races.
 *  ponytail: a takedown through wrangler doesn't release its bytes, so the count only errs high (safe side). */
export class Quota {
  constructor(private readonly state: { storage: StorageLike }, _env?: unknown, private readonly limits = QUOTA_LIMITS) {}

  async fetch(request: Request): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const bytes = Number(searchParams.get('bytes'));
    if (!Number.isFinite(bytes) || bytes < 0) return new Response(null, { status: 400 });
    const month = new Date().toISOString().slice(0, 7);
    const stored = await this.state.storage.get<Usage>('usage');
    const usage: Usage = stored?.month === month ? stored : { bytes: stored?.bytes ?? 0, month, uploads: 0 };
    if (pathname === '/reserve') {
      if (usage.bytes + bytes > this.limits.storedBytes || usage.uploads >= this.limits.uploadsPerMonth) {
        return new Response(null, { status: 507 });
      }
      usage.bytes += bytes;
      usage.uploads += 1;
    } else {
      usage.bytes = Math.max(0, usage.bytes - bytes);
    }
    await this.state.storage.put('usage', usage);
    return new Response(null, { status: 204 });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function handle(request: Request, env: Env, fetcher: typeof fetch = fetch, now = new Date()): Promise<Response> {
  const cors = corsHeaders(request, env);
  const respond = (response: Response): Response => {
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  };
  if (request.method === 'OPTIONS') return respond(new Response(null, { status: 204 }));
  const { pathname } = new URL(request.url);
  const id = ID_PATTERN.exec(pathname)?.[1];
  const post = request.method === 'POST';
  try {
    if (pathname === '/s' && post) return respond(await create(request, env, fetcher));
    if (pathname === '/e' && post) return respond(await usageBeacon(request, env, now));
    if (pathname === '/feedback' && post) return respond(await feedback(request, env, fetcher, now));
    if (id && request.method === 'GET') return respond(await read(id, env));
    if (id && request.method === 'DELETE') return respond(await remove(id, request, env));
  } catch {
    // R2 or D1 failed: say so with CORS headers, so the browser reads a server error, not "offline".
    return respond(json(500, { error: 'storage-error' }));
  }
  const known = id || ['/s', '/e', '/feedback'].includes(pathname);
  return respond(json(known ? 405 : 404, { error: known ? 'method-not-allowed' : 'not-found' }));
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
  // wrangler.toml [triggers]: once a night.
  scheduled: async (_controller: unknown, env: Env): Promise<void> => {
    if (env.DB?.batch) await pruneUsage(env.DB as Required<D1DatabaseLike>, new Date());
  },
};
