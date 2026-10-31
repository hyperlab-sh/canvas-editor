// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDocument, createTestNode } from '../src/opencanvas/testing/builders/documentBuilder';
import { decryptDocument, encryptDocument } from '../src/services/share/shareCrypto';
import { USAGE_EVENTS } from '../src/services/usage/usageEvents';
import { FakeBucket, FakeD1, FakeQuotaNamespace } from './fakeBucket';
import { handle, MAX_BODY_BYTES, type Env } from './index';

/** Cloudflare's documented siteverify shapes. */
const TURNSTILE_OK = { success: true, 'error-codes': [], challenge_ts: '2026-10-07T00:00:00Z', hostname: 'app.openflowkit.com' };
const TURNSTILE_BAD = { success: false, 'error-codes': ['invalid-input-response'] };

const siteverify = (result: unknown): typeof fetch => async (input, init) => {
  expect(String(input)).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  const form = init?.body as URLSearchParams;
  expect(form.get('secret')).toBe('secret');
  return Response.json(result);
};

let bucket: FakeBucket;
let quota: FakeQuotaNamespace;
let env: Env;
beforeEach(() => {
  bucket = new FakeBucket();
  quota = new FakeQuotaNamespace();
  env = { SHARES: bucket, QUOTA: quota, TURNSTILE_SECRET: 'secret' };
});
const usage = () => quota.storage.values.get('usage') as { bytes: number; month: string; uploads: number } | undefined;

const post = (body: Uint8Array | string, headers: Record<string, string> = {}) =>
  new Request('https://share.openflowkit.com/s', { method: 'POST', body, headers: { 'X-Turnstile-Token': 'tok', ...headers } });
/** Our envelope's shape: version byte 1, then at least IV + tag. */
const envelope = (length = 40, fill = 7): Uint8Array => { const bytes = new Uint8Array(length).fill(fill); bytes[0] = 1; return bytes; };
const upload = async (body: Uint8Array | string = envelope()) => {
  const response = await handle(post(body), env, siteverify(TURNSTILE_OK));
  return { response, ...(response.status === 201 ? await response.json() as { id: string; deleteToken: string } : { id: '', deleteToken: '' }) };
};
const url = (id: string) => `https://share.openflowkit.com/s/${id}`;

describe('share worker', () => {
  it('POST stores the body and GET streams it back', async () => {
    const sent = envelope(64, 9);
    const { response, id } = await upload(sent);
    expect(response.status).toBe(201);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const got = await handle(new Request(url(id)), env);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(sent);
    expect(got.headers.get('Cache-Control')).toBe('no-store');
    // Ciphertext is never rendered by a browser, whatever it looks like.
    expect(got.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(got.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(got.headers.get('Content-Disposition')).toBe('attachment');
    expect(got.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
  });

  it('stores only ciphertext: no plaintext label, and only a hash of the delete token', async () => {
    const label = 'Confidential acquisition target';
    const { body } = await encryptDocument(createTestDocument({ nodes: [createTestNode('a', { content: { label } })] }));
    const { id, deleteToken } = await upload(body);
    const stored = bucket.objects.get(id)!;
    expect(new TextDecoder('latin1').decode(stored.bytes)).not.toContain(label);
    expect(stored.customMetadata.deleteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.customMetadata)).not.toContain(deleteToken);
  });

  it('a stored body decrypts with the key the browser kept', async () => {
    const doc = createTestDocument({ nodes: [createTestNode('a')] });
    const { body, key } = await encryptDocument(doc);
    const { id } = await upload(body);
    const got = new Uint8Array(await (await handle(new Request(url(id)), env)).arrayBuffer());
    expect(await decryptDocument(got, key)).toEqual(doc);
  });

  it('413 over 1 MiB, by Content-Length and by streamed bytes; exactly 1 MiB passes', async () => {
    const big = envelope(MAX_BODY_BYTES + 1);
    expect((await handle(post(big), env, siteverify(TURNSTILE_OK))).status).toBe(413);
    const chunked = new Request('https://share.openflowkit.com/s', {
      method: 'POST', headers: { 'X-Turnstile-Token': 'tok' }, duplex: 'half',
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(big.slice(0, 600_000)); c.enqueue(big.slice(0, 600_000)); c.close(); } }),
    } as RequestInit);
    expect((await handle(chunked, env, siteverify(TURNSTILE_OK))).status).toBe(413);
    expect(bucket.objects.size).toBe(0);
    expect((await upload(envelope(MAX_BODY_BYTES))).response.status).toBe(201);
  });

  it('413 on a declared Content-Length over 1 MiB, before the body is read or Turnstile asked', async () => {
    const neverCalled: typeof fetch = async () => { throw new Error('siteverify should not run'); };
    const response = await handle(post(envelope(), { 'Content-Length': String(MAX_BODY_BYTES + 1) }), env, neverCalled);
    expect(response.status).toBe(413);
  });

  it('400 for a body that is not our envelope (wrong version byte, or too short)', async () => {
    const wrongVersion = envelope(); wrongVersion[0] = 2;
    for (const body of [wrongVersion, envelope(28), new Uint8Array([1]), new TextEncoder().encode('{"hello":"plaintext json"}')]) {
      expect((await handle(post(body), env, siteverify(TURNSTILE_OK))).status).toBe(400);
    }
    expect(bucket.objects.size).toBe(0);
    expect((await upload(envelope(29))).response.status).toBe(201);
  });

  it('500 JSON with CORS headers when R2 fails, on every route', async () => {
    const { id, deleteToken } = await upload();
    const boom = async () => { throw new Error('R2 is down'); };
    Object.assign(bucket, { put: boom, get: boom, head: boom, delete: boom });
    const origin = { Origin: 'http://localhost:3000' };
    const responses = await Promise.all([
      handle(post(envelope(), origin), env, siteverify(TURNSTILE_OK)),
      handle(new Request(url(id), { headers: origin }), env),
      handle(new Request(url(id), { method: 'DELETE', headers: { ...origin, Authorization: `Bearer ${deleteToken}` } }), env),
    ]);
    // The failed upload gave its reserved bytes back; only the first upload counts.
    expect(usage()?.bytes).toBe(envelope().length);
    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'storage-error' });
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    }
  });

  it('403 when Turnstile rejects the token, and nothing is stored', async () => {
    const response = await handle(post(envelope()), env, siteverify(TURNSTILE_BAD));
    expect(response.status).toBe(403);
    expect(bucket.objects.size).toBe(0);
  });

  it('503 when Turnstile cannot be reached', async () => {
    const down: typeof fetch = async () => { throw new TypeError('fetch failed'); };
    expect((await handle(post(envelope()), env, down)).status).toBe(503);
  });

  it('429 when the rate limiter says no, keyed by IP, before Turnstile is asked', async () => {
    const keys: string[] = [];
    env.RATE_LIMITER = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
    const neverCalled: typeof fetch = async () => { throw new Error('siteverify should not run'); };
    const response = await handle(post(envelope(), { 'CF-Connecting-IP': '203.0.113.7' }), env, neverCalled);
    expect(response.status).toBe(429);
    expect(keys).toEqual(['203.0.113.7']);
  });

  it('400 on an empty body', async () => {
    expect((await handle(post(new Uint8Array()), env, siteverify(TURNSTILE_OK))).status).toBe(400);
  });

  it('404 for an unknown id and for a path that is not an id', async () => {
    expect((await handle(new Request(url('0'.repeat(32))), env)).status).toBe(404);
    expect((await handle(new Request(url('nope')), env)).status).toBe(404);
    expect((await handle(new Request(url('0'.repeat(32)), { method: 'DELETE' }), env)).status).toBe(404);
  });

  it('403 for a wrong or missing delete token, and the object survives', async () => {
    const { id } = await upload();
    for (const headers of [{ Authorization: 'Bearer wrong' }, {}] as Record<string, string>[]) {
      expect((await handle(new Request(url(id), { method: 'DELETE', headers }), env)).status).toBe(403);
    }
    expect(bucket.objects.has(id)).toBe(true);
  });

  it('204 on delete with the right token, then 404', async () => {
    const { id, deleteToken } = await upload();
    const removed = await handle(new Request(url(id), { method: 'DELETE', headers: { Authorization: `Bearer ${deleteToken}` } }), env);
    expect(removed.status).toBe(204);
    expect((await handle(new Request(url(id)), env)).status).toBe(404);
  });

  it('CORS origins come from ALLOWED_ORIGINS (default: the app), localhost always', async () => {
    const allowed = async (origin: string, vars: Partial<Env> = {}) => (await handle(new Request(url('0'.repeat(32)), {
      method: 'OPTIONS', headers: { Origin: origin },
    }), { ...env, ...vars })).headers.get('Access-Control-Allow-Origin');
    expect(await allowed('https://app.openflowkit.com')).toBe('https://app.openflowkit.com');
    expect(await allowed('https://staging.example.com')).toBeNull();
    const vars = { ALLOWED_ORIGINS: 'https://staging.example.com, https://app.example.org' };
    expect(await allowed('https://staging.example.com', vars)).toBe('https://staging.example.com');
    expect(await allowed('https://app.example.org', vars)).toBe('https://app.example.org');
    expect(await allowed('https://app.openflowkit.com', vars)).toBeNull();
    expect(await allowed('http://localhost:5173', vars)).toBe('http://localhost:5173');
  });

  it('CORS: allows the app and localhost, not other origins', async () => {
    const preflight = (origin: string) => handle(new Request(url('0'.repeat(32)), {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    }), env);
    for (const origin of ['https://app.openflowkit.com', 'http://localhost:3000', 'http://127.0.0.1:4173']) {
      const response = await preflight(origin);
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, DELETE, OPTIONS');
    }
    expect((await preflight('https://evil.example')).headers.get('Access-Control-Allow-Origin')).toBeNull();
    const { response } = await upload();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('507 once stored bytes would pass the cap, nothing stored; a delete frees the room', async () => {
    quota = new FakeQuotaNamespace({ storedBytes: 100, uploadsPerMonth: 10 });
    env.QUOTA = quota;
    const first = await upload(envelope(60));
    expect(first.response.status).toBe(201);
    const full = await handle(post(envelope(60)), env, siteverify(TURNSTILE_OK));
    expect(full.status).toBe(507);
    expect(await full.json()).toEqual({ error: 'storage-full' });
    expect(bucket.objects.size).toBe(1);
    await handle(new Request(url(first.id), { method: 'DELETE', headers: { Authorization: `Bearer ${first.deleteToken}` } }), env);
    expect(usage()?.bytes).toBe(0);
    expect((await upload(envelope(60))).response.status).toBe(201);
  });

  it('507 after the month\'s upload cap; a new month resets uploads but keeps stored bytes', async () => {
    quota = new FakeQuotaNamespace({ storedBytes: 1_000, uploadsPerMonth: 2 });
    env.QUOTA = quota;
    expect((await upload()).response.status).toBe(201);
    expect((await upload()).response.status).toBe(201);
    expect((await upload()).response.status).toBe(507);
    quota.storage.values.set('usage', { ...usage()!, month: '2000-01' });
    expect((await upload()).response.status).toBe(201);
    expect(usage()).toMatchObject({ bytes: envelope().length * 3, uploads: 1 });
  });
});

const NOW = new Date('2026-10-11T09:30:00Z');
const UID = '0123456789abcdef0123456789abcdef';
const beacon = (overrides: Record<string, unknown> = {}) => ({
  v: 1, uid: UID, firstSeen: '2026-10-01', source: 'hn', entry: 'home', version: '2.1.0', returning: true,
  counts: { session: 1, created_draw: 2, active_seconds: 300 }, ...overrides,
});
const sendBeacon = (body: unknown, headers: Record<string, string> = {}, now = NOW) => handle(Object.assign(
  new Request('https://share.openflowkit.com/e', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'CF-Connecting-IP': '198.51.100.4', 'User-Agent': 'Mozilla/5.0 Test', ...headers },
  }), { cf: { country: 'IN' } }), env, undefined, now);

describe('usage beacon (POST /e)', () => {
  let db: FakeD1;
  beforeEach(() => { db = new FakeD1(); env.DB = db; env.USAGE_SALT = 'salt'; });
  const sessions = () => db.table('sessions');

  it('204 and one sessions row: the fields, then one column per event in contract order', async () => {
    const response = await sendBeacon(beacon());
    expect(response.status).toBe(204);
    expect(sessions()).toHaveLength(1);
    const row = sessions()[0];
    expect(row).toMatchObject({
      received_at: '2026-10-11T09:30:00.000Z', day: '2026-10-11', first_seen: '2026-10-01', source: 'hn', entry: 'home',
      version: '2.1.0', returning: 1, country: 'IN',
    });
    expect(row.user).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(row).slice(-USAGE_EVENTS.length - 1)).toEqual([...USAGE_EVENTS, 'beacons']);
    expect(row.beacons).toBe(1);
    expect(USAGE_EVENTS.map((event) => row[event])).toEqual(USAGE_EVENTS.map((event) =>
      ({ session: 1, created_draw: 2, active_seconds: 300 } as Record<string, number>)[event] ?? 0));
  });

  it('keeps only known counts, clamped: 0..1000, active_seconds 0..86400', async () => {
    await sendBeacon(beacon({ counts: { session: -4, created_ai: 5_000, export_image: 2.9, code_opened: '7', active_seconds: 1e9, bogus: 9 } }));
    const row = sessions()[0];
    expect(row).toMatchObject({ session: 0, created_ai: 1_000, export_image: 2, code_opened: 0, active_seconds: 86_400 });
    expect(row).not.toHaveProperty('bogus');
  });

  it('never stores the install id, ip or user agent; the user key is stable across days, distinct per install', async () => {
    await sendBeacon(beacon());
    await sendBeacon(beacon(), {}, new Date('2026-11-20T23:59:00Z'));
    await sendBeacon(beacon({ uid: 'f'.repeat(32) }));
    const stored = JSON.stringify(db.rows);
    for (const secret of [UID, '198.51.100.4', 'Mozilla']) expect(stored).not.toContain(secret);
    const [first, nextMonth, other] = sessions().map((row) => row.user);
    expect(nextMonth).toBe(first);
    expect(other).not.toBe(first);
    env.USAGE_SALT = 'another-salt';
    await sendBeacon(beacon());
    expect(sessions()[3].user).not.toBe(first);
  });

  it('first_seen: a real day from launch to today, else today', async () => {
    for (const firstSeen of ['2026-01-01', '2026-10-11', '2026-10-12', '2025-12-31', '2026-02-30', '11/10/2026', 42, undefined]) {
      await sendBeacon(beacon({ firstSeen }));
    }
    expect(sessions().map((row) => row.first_seen)).toEqual([
      '2026-01-01', '2026-10-11', '2026-10-11', '2026-10-11', '2026-10-11', '2026-10-11', '2026-10-11', '2026-10-11',
    ]);
  });

  it('source and version: lowercase slugs, cut to 40 / 20, anything else "other"', async () => {
    await sendBeacon(beacon({ source: ' ProductHunt ', version: '2.1.0-beta.3' }));
    await sendBeacon(beacon({ source: 'evil<script>', version: 'v 2' }));
    await sendBeacon(beacon({ source: 'a'.repeat(60), version: '1'.repeat(30) }));
    expect(sessions().map((row) => [row.source, row.version])).toEqual([
      ['producthunt', '2.1.0-beta.3'], ['other', 'other'], ['a'.repeat(40), '1'.repeat(20)],
    ]);
  });

  it('400 on a bad beacon, nothing stored', async () => {
    const bad = [
      'not json', [], beacon({ v: 2 }), beacon({ uid: UID.toUpperCase() }), beacon({ uid: 'abc' }), beacon({ uid: undefined }),
      beacon({ entry: 'admin' }), beacon({ returning: 'yes' }), beacon({ counts: [1, 2] }), beacon({ source: 3 }), beacon({ version: null }),
    ];
    for (const body of bad) expect((await sendBeacon(body)).status).toBe(400);
    expect(db.rows).toHaveLength(0);
  });

  it('413 over 4 KiB', async () => {
    expect((await sendBeacon(beacon({ source: 'x'.repeat(5_000) }))).status).toBe(413);
  });

  it('429 from the rate limiter, keyed e:<ip> so beacons and uploads keep separate budgets', async () => {
    const keys: string[] = [];
    env.EVENT_LIMITER = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
    expect((await sendBeacon(beacon())).status).toBe(429);
    expect(keys).toEqual(['e:198.51.100.4']);
    expect(db.rows).toHaveLength(0);
  });

  it('204 without writing when DB or USAGE_SALT is absent (local dev)', async () => {
    env.USAGE_SALT = undefined;
    expect((await sendBeacon(beacon())).status).toBe(204);
    env.USAGE_SALT = 'salt';
    env.DB = undefined;
    expect((await sendBeacon(beacon())).status).toBe(204);
    expect(db.rows).toHaveLength(0);
  });

  it('405 for GET /e', async () => {
    expect((await handle(new Request('https://share.openflowkit.com/e'), env)).status).toBe(405);
  });

  it('the migrations declare an integer column for every usage event (a new event needs a migration)', () => {
    const migration = (name: string) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
    // 0004 rebuilt the table (one row per person per day); its definition is the current schema.
    const table = /CREATE TABLE sessions_by_day \(([\s\S]*?)\n\);/.exec(migration('0004_sessions_by_day.sql'))?.[1] ?? '';
    const declared = new Set([...table.matchAll(/^\s*"?(\w+)"?\s+INTEGER NOT NULL DEFAULT 0/gm)].map((match) => match[1]));
    expect(USAGE_EVENTS.filter((event) => !declared.has(event))).toEqual([]);
  });
});

const sendFeedback = (body: unknown, fetcher: typeof fetch = siteverify(TURNSTILE_OK), headers: Record<string, string> = {}) =>
  handle(Object.assign(new Request('https://share.openflowkit.com/feedback', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.4', 'X-Turnstile-Token': 'tok', ...headers },
  }), { cf: { country: 'DE' } }), env, fetcher, NOW);
const noTurnstile: typeof fetch = async () => { throw new Error('siteverify should not run'); };

describe('feedback (POST /feedback)', () => {
  let db: FakeD1;
  beforeEach(() => { db = new FakeD1(); env.DB = db; });
  const rows = () => db.table('feedback');

  it('201 and one row with the validated fields; pay deduped into a comma list', async () => {
    const response = await sendFeedback({
      kind: 'product', pmf: 'very', pay: ['sync', 'collaboration', 'sync'], text: '  Love the repo map  ', email: 'ada@example.com', version: '2.1.0', extra: 'ignored',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(rows()).toEqual([{
      created_at: '2026-10-11T09:30:00.000Z', kind: 'product', feature: null, rating: null, pmf: 'very', pay: 'sync,collaboration',
      plan: null, price: null, text: 'Love the repo map', email: 'ada@example.com', version: '2.1.0', country: 'DE',
    }]);
  });

  it('a bare thumbs or PMF answer needs no Turnstile', async () => {
    expect((await sendFeedback({ kind: 'feature', feature: 'repo_map', rating: 'up', version: '2.1.0' }, noTurnstile)).status).toBe(201);
    expect((await sendFeedback({ kind: 'product', pmf: 'not', pay: ['free'], version: '2.1.0' }, noTurnstile)).status).toBe(201);
    expect(rows().map((row) => [row.feature, row.rating, row.pmf, row.pay])).toEqual([['repo_map', 'up', null, null], [null, null, 'not', 'free']]);
  });

  it('text or email needs Turnstile: 403 rejected, 503 unreachable, nothing stored', async () => {
    const down: typeof fetch = async () => { throw new TypeError('fetch failed'); };
    expect((await sendFeedback({ kind: 'general', text: 'hi', version: '2.1.0' }, siteverify(TURNSTILE_BAD))).status).toBe(403);
    expect((await sendFeedback({ kind: 'general', email: 'a@b.co', version: '2.1.0' }, down)).status).toBe(503);
    expect(rows()).toHaveLength(0);
  });

  it('400 on anything outside the contract, nothing stored', async () => {
    const ok = { kind: 'general', text: 'hi', version: '2.1.0' };
    const bad = [
      'not json', [], { ...ok, kind: 'rant' }, { ...ok, kind: undefined }, { kind: 'feature', rating: 'up', version: '2.1.0' },
      { kind: 'feature', feature: 'billing', rating: 'up', version: '2.1.0' }, { ...ok, rating: 'meh' }, { ...ok, pmf: 'extremely' },
      { ...ok, pay: ['crypto'] }, { ...ok, pay: 'sync' }, { ...ok, text: 'x'.repeat(2_001) }, { ...ok, text: 7 },
      { ...ok, email: 'not-an-email' }, { ...ok, email: 'a b@c.d' }, { ...ok, email: `${'a'.repeat(250)}@b.co` },
      { ...ok, version: '1'.repeat(21) }, { ...ok, version: undefined }, { kind: 'general', text: '   ', pay: [], version: '2.1.0' },
    ];
    for (const body of bad) expect((await sendFeedback(body)).status, JSON.stringify(body)).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it('a Pro waitlist entry: plan, price, features and an email (Turnstile checked)', async () => {
    const response = await sendFeedback({
      kind: 'pro', plan: 'team', price: 12, pay: ['collaboration', 'drift'], email: 'ada@example.com', version: '2.1.0',
    });
    expect(response.status).toBe(201);
    expect(rows()).toMatchObject([{ kind: 'pro', plan: 'team', price: 12, pay: 'collaboration,drift', email: 'ada@example.com' }]);
  });

  it('400 for a Pro entry without a plan or an email, a bad plan or price, or plan fields on other kinds', async () => {
    const pro = { kind: 'pro', plan: 'pro', email: 'ada@example.com', version: '2.1.0' };
    const bad = [
      { ...pro, plan: undefined }, { ...pro, email: undefined }, { ...pro, plan: 'gold' }, { ...pro, price: '12' }, { ...pro, price: 12.5 },
      { ...pro, price: -1 }, { ...pro, price: 41 }, { kind: 'general', text: 'hi', plan: 'pro', version: '2.1.0' },
      { kind: 'product', pmf: 'very', price: 9, version: '2.1.0' },
    ];
    for (const body of bad) expect((await sendFeedback(body)).status, JSON.stringify(body)).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it('413 over 8 KiB', async () => {
    expect((await sendFeedback({ kind: 'general', text: 'x'.repeat(9_000), version: '2.1.0' })).status).toBe(413);
  });

  it('429 from the rate limiter keyed f:<ip>, before Turnstile', async () => {
    const keys: string[] = [];
    env.EVENT_LIMITER = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
    expect((await sendFeedback({ kind: 'general', text: 'hi', version: '2.1.0' }, noTurnstile)).status).toBe(429);
    expect(keys).toEqual(['f:198.51.100.4']);
  });

  it('503 feedback-unavailable without a DB binding', async () => {
    env.DB = undefined;
    const response = await sendFeedback({ kind: 'feature', feature: 'ai', rating: 'down', version: '2.1.0' }, noTurnstile);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'feedback-unavailable' });
  });

  it('500 JSON with CORS headers when D1 fails, on /e and /feedback', async () => {
    env.USAGE_SALT = 'salt';
    env.DB = { prepare: () => { throw new Error('D1 is down'); } };
    const origin = { Origin: 'https://app.openflowkit.com' };
    for (const response of [
      await sendBeacon(beacon(), origin),
      await sendFeedback({ kind: 'feature', feature: 'ai', rating: 'up', version: '2.1.0' }, noTurnstile, origin),
    ]) {
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'storage-error' });
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.openflowkit.com');
    }
  });
});
