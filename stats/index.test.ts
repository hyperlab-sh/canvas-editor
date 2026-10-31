// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { USAGE_EVENTS } from '../src/services/usage/usageEvents';
import {
  accessToken, esc, handle, loadGrowth, renderPage, verifyAccessJwt,
  type CacheLike, type D1DatabaseLike, type D1StatementLike, type Env, type Growth,
} from './index';
import { INSERT_SESSION, KEEP_USAGE_DAYS, pruneUsage } from '../worker/index';
import { cohortStarts, inlineParams, loadStats, retentionLabel, type Run } from './queries';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-tag-1';
const CERTS = `https://${TEAM}/cdn-cgi/access/certs`;
const NOW = new Date('2026-10-14T12:00:00.000Z'); // a Wednesday
const SECONDS = NOW.getTime() / 1000;

// ---- real SQLite with every migration ---------------------------------------------------------------------------

const MIGRATIONS = ['0001_init.sql', '0002_feedback_read.sql', '0003_pro_waitlist.sql', '0004_sessions_by_day.sql']
  .map((name) => readFileSync(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8'));
function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}
const sqliteRun = (db: DatabaseSync): Run => async (queries) => queries.map((query) => db.prepare(query.sql).all(...query.params) as Record<string, unknown>[]);

/** D1's prepare/bind/batch over node:sqlite, as the Worker calls it. */
class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly db: DatabaseSync) {}
  prepare(sql: string): D1StatementLike {
    const statement = (values: unknown[]): D1StatementLike & { sql: string; values: unknown[] } =>
      ({ sql, values, bind: (...next: unknown[]) => statement(next) });
    return statement([]);
  }
  async batch(statements: D1StatementLike[]) {
    return (statements as (D1StatementLike & { sql: string; values: (string | number | null)[] })[])
      .map((statement) => ({ results: this.db.prepare(statement.sql).all(...statement.values) as Record<string, unknown>[] }));
  }
}

type Counts = Partial<Record<(typeof USAGE_EVENTS)[number], number>>;
/** One beacon through the Worker's own statement, so a second beacon the same day folds into that day's row. */
function beacon(db: DatabaseSync, day: string, user: string, firstSeen: string, source: string, country: string, counts: Counts, entry = 'home') {
  db.prepare(INSERT_SESSION).run(`${day}T10:00:00.000Z`, day, user, firstSeen, source, entry, '2.1.0', 0, country,
    ...USAGE_EVENTS.map((event) => counts[event] ?? 0), 1);
}
interface Feedback {
  created_at: string; kind: string; feature?: string; rating?: string; pmf?: string; pay?: string; plan?: string; price?: number;
  text?: string; email?: string; country?: string; read_at?: string;
}
function feedback(db: DatabaseSync, row: Feedback) {
  db.prepare(`INSERT INTO feedback (created_at, kind, feature, rating, pmf, pay, plan, price, text, email, version, country, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.created_at, row.kind, row.feature ?? null, row.rating ?? null, row.pmf ?? null, row.pay ?? null, row.plan ?? null,
      row.price ?? null, row.text ?? null, row.email ?? null, '2.1.0', row.country ?? 'DE', row.read_at ?? null);
}

const PAYLOAD = `<script>alert(1)</script> "quoted" & 'single'`;
/** Six people and five feedback rows; every expected number below is worked out by hand in the comments. */
function seed(db: DatabaseSync) {
  // A: cohort 09-07; back in week 1 (09-15) and week 4 (10-06).
  beacon(db, '2026-09-07', 'A', '2026-09-07', 'direct', 'GB', { session: 1, created_draw: 1, active_seconds: 120 });
  beacon(db, '2026-09-15', 'A', '2026-09-07', 'direct', 'GB', { session: 1, active_seconds: 60 });
  beacon(db, '2026-10-06', 'A', '2026-09-07', 'direct', 'GB', { session: 1, ai_applied: 1, active_seconds: 300 });
  // B: cohort 09-07, never back.
  beacon(db, '2026-09-07', 'B', '2026-09-07', 'direct', 'GB', { session: 1, active_seconds: 30 });
  // F: cohort 09-14 (day one outside the 30-day range), skips week 1, back in week 4 (10-14, still running).
  beacon(db, '2026-09-14', 'F', '2026-09-14', 'direct', 'US', { session: 1, active_seconds: 50 });
  beacon(db, '2026-10-14', 'F', '2026-09-14', 'direct', 'US', { session: 1, active_seconds: 20 });
  // C, D: cohort 10-05. C creates on day one and is back on 10-13 (week 1, running); D came from a share link.
  beacon(db, '2026-10-05', 'C', '2026-10-05', 'hn', 'DE', { session: 2, created_template: 1, share_view: 1, active_seconds: 600 });
  beacon(db, '2026-10-13', 'C', '2026-10-05', 'hn', 'DE', { session: 1, export_image: 1, active_seconds: 240 });
  beacon(db, '2026-10-05', 'D', '2026-10-05', 'x', 'US', { session: 1, shared_copied: 1, active_seconds: 10 }, 'shared');
  // E: new today, two beacons.
  beacon(db, '2026-10-14', 'E', '2026-10-14', 'github', 'DE', { session: 1, created_code: 1, agent_mcp: 1, app_error: 1, active_seconds: 90 });
  beacon(db, '2026-10-14', 'E', '2026-10-14', 'github', 'DE', { export_data: 1, active_seconds: 30 });

  feedback(db, { created_at: '2026-10-14T09:00:00.000Z', kind: 'product', pmf: 'very', pay: 'collaboration,sync', text: PAYLOAD, email: 'a@example.com' });
  feedback(db, { created_at: '2026-10-10T10:00:00.000Z', kind: 'feature', feature: 'ai', rating: 'up', country: 'US' });
  feedback(db, { created_at: '2026-10-01T10:00:00.000Z', kind: 'feature', feature: 'ai', rating: 'down', pmf: 'somewhat', pay: 'free' });
  feedback(db, { created_at: '2026-09-20T10:00:00.000Z', kind: 'product', pmf: 'not', email: 'b@example.com', read_at: '2026-09-21T00:00:00.000Z' });
  feedback(db, { created_at: '2026-08-01T10:00:00.000Z', kind: 'general', pmf: 'very', text: 'old but unread' });
}

// ---- JWTs -------------------------------------------------------------------------------------------------------

const b64url = (bytes: Uint8Array | string): string =>
  Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString('base64url');
const rsa = () => crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
) as Promise<CryptoKeyPair>;
const signingPair = await rsa();
const otherPair = await rsa();
const publicJwk = { ...await crypto.subtle.exportKey('jwk', signingPair.publicKey), kid: 'k1' };

async function jwt(claims: Record<string, unknown> = {}, key = signingPair.privateKey, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }) {
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify({
    aud: [AUD], iss: `https://${TEAM}`, exp: SECONDS + 600, iat: SECONDS - 10, email: 'varun@openflowkit.com', ...claims,
  }))}`;
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body))))}`;
}

let fetched: string[];
let growthAnswers: Record<string, () => Response>;
const fetcher: typeof fetch = async (input) => {
  const url = String(input);
  fetched.push(url);
  if (url === CERTS) return Response.json({ keys: [publicJwk], public_cert: { kid: 'k1' } });
  const answer = growthAnswers[url];
  if (!answer) throw new TypeError('fetch failed');
  return answer();
};
const STARS = 'https://api.github.com/repos/openflowkit/openflowkit';
const NPM = 'https://api.npmjs.org/downloads/point/last-week/openflowkit';
beforeEach(() => {
  fetched = [];
  growthAnswers = { [STARS]: () => Response.json({ stargazers_count: 1234 }), [NPM]: () => Response.json({ downloads: 54 }) };
});
const verify = (token: string | null, config = { teamDomain: TEAM, aud: AUD }) => verifyAccessJwt(token, config, fetcher, NOW.getTime(), new Map());

describe('Access JWT', () => {
  it('accepts a token signed by the team key for this audience and issuer', async () => {
    expect(await verify(await jwt())).toBe(true);
    expect(await verify(await jwt({ aud: AUD }))).toBe(true);
    expect(fetched).toEqual([CERTS, CERTS]);
  });

  it('rejects a wrong audience, an expired token, a wrong issuer, a not-yet-valid one', async () => {
    expect(await verify(await jwt({ aud: ['someone-else'] }))).toBe(false);
    expect(await verify(await jwt({ exp: SECONDS - 1 }))).toBe(false);
    expect(await verify(await jwt({ exp: undefined }))).toBe(false);
    expect(await verify(await jwt({ iss: 'https://evil.cloudflareaccess.com' }))).toBe(false);
    expect(await verify(await jwt({ nbf: SECONDS + 60 }))).toBe(false);
  });

  it('rejects a bad signature, another algorithm, an unknown key, and garbage', async () => {
    expect(await verify(await jwt({}, otherPair.privateKey))).toBe(false);
    const good = await jwt();
    const [header, , signature] = good.split('.');
    expect(await verify(`${header}.${b64url(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: SECONDS + 600 }))}.${signature}`)).toBe(false);
    expect(await verify(await jwt({}, signingPair.privateKey, { alg: 'none', kid: 'k1' }))).toBe(false);
    expect(await verify(await jwt({}, signingPair.privateKey, { alg: 'RS256', kid: 'k2' }))).toBe(false);
    for (const token of ['', 'a.b', 'a.b.c', `${good}.x`]) expect(await verify(token)).toBe(false);
  });

  it('fails closed when the token is missing, the vars are empty, or the certs are unreachable', async () => {
    const token = await jwt();
    expect(await verify(null)).toBe(false);
    expect(await verify(token, { teamDomain: '', aud: AUD })).toBe(false);
    expect(await verify(token, { teamDomain: TEAM, aud: '' })).toBe(false);
    const down: typeof fetch = async () => { throw new TypeError('fetch failed'); };
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD }, down, NOW.getTime(), new Map())).toBe(false);
    const notFound: typeof fetch = async () => new Response('no', { status: 404 });
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD }, notFound, NOW.getTime(), new Map())).toBe(false);
  });

  it('caches the keys for an hour, then fetches them again', async () => {
    const cache = new Map();
    const token = await jwt({ exp: SECONDS + 7200 });
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD }, fetcher, NOW.getTime(), cache)).toBe(true);
    expect(await verifyAccessJwt(token, { teamDomain: `https://${TEAM}/`, aud: AUD }, fetcher, NOW.getTime() + 3_599_000, cache)).toBe(true);
    expect(fetched).toEqual([CERTS]);
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD }, fetcher, NOW.getTime() + 3_601_000, cache)).toBe(true);
    expect(fetched).toEqual([CERTS, CERTS]);
  });

  it('reads the token from the header, else the CF_Authorization cookie', () => {
    expect(accessToken(new Request('https://stats.openflowkit.com/', { headers: { 'Cf-Access-Jwt-Assertion': 'h.p.s' } }))).toBe('h.p.s');
    expect(accessToken(new Request('https://stats.openflowkit.com/', { headers: { Cookie: 'a=1; CF_Authorization=c.p.s; b=2' } }))).toBe('c.p.s');
    expect(accessToken(new Request('https://stats.openflowkit.com/'))).toBeNull();
  });
});

// ---- queries ----------------------------------------------------------------------------------------------------

describe('loadStats on seeded SQLite', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = database(); seed(db); });

  it('daily active and new people fill every day of the range', async () => {
    const s = await loadStats(sqliteRun(db), NOW, 30);
    expect(s.from).toBe('2026-09-15');
    expect(s.daily).toHaveLength(30);
    expect(s.daily.filter((row) => row.people || row.new || row.sessions)).toEqual([
      { day: '2026-09-15', people: 1, new: 0, sessions: 1 }, // A
      { day: '2026-10-05', people: 2, new: 2, sessions: 3 }, // C (2 sessions), D
      { day: '2026-10-06', people: 1, new: 0, sessions: 1 }, // A
      { day: '2026-10-13', people: 1, new: 0, sessions: 1 }, // C
      { day: '2026-10-14', people: 2, new: 1, sessions: 2 }, // E (two beacons, one session), F
    ]);
  });

  it('DAU, WAU, MAU and stickiness', async () => {
    const { reach } = await loadStats(sqliteRun(db), NOW, 30);
    // Today E, F. Since 10-08: C, E, F. Since 09-15: A, C, D, E, F. Person-days since 09-15: A×2, C×2, D, E, F = 7.
    expect(reach).toMatchObject({ dau: 2, wau: 3, mau: 5, newThisWeek: 1, active: 5 });
    expect(reach.avgDau).toBeCloseTo(7 / 30);
    expect(reach.stickiness).toBeCloseTo(7 / 150);
  });

  it('week-1 and week-4 retention per Monday cohort, with running and pending windows', async () => {
    const s = await loadStats(sqliteRun(db), NOW, 30);
    expect(cohortStarts(s.today)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05']);
    expect(s.retention.map((row) => [row.cohort, row.size, retentionLabel(row.week1), retentionLabel(row.week4)])).toEqual([
      ['2026-08-31', 0, '—', '—'],
      ['2026-09-07', 2, '50%', '50%'], // A back in both windows, B in neither
      ['2026-09-14', 1, '0%', '100%*'], // F skipped 09-21..27; back 10-14, inside week 4 (10-12..18), still open
      ['2026-09-21', 0, '—', '—'],
      ['2026-09-28', 0, '—', '—'],
      ['2026-10-05', 2, '50%*', '—'], // C back 10-13 in week 1 (10-12..18, open); week 4 not started
    ]);
    expect(s.retention[5].week4).toEqual({ rate: null, state: 'pending' });
    expect(s.retention[2].week1).toEqual({ rate: 0, state: 'closed' });
  });

  it('activation, sessions per person, median engaged minutes', async () => {
    const s = await loadStats(sqliteRun(db), NOW, 30);
    // New since 09-15 with a row on day one: C (template), D (nothing), E (code) → 2 of 3.
    expect(s.activation).toEqual({ people: 3, activated: 2, rate: 2 / 3 });
    // Sessions 2 (A) + 3 (C) + 1 (D) + 1 (E) + 1 (F) = 8 over 5 people.
    expect(s.sessionsPerPerson).toBe(1.6);
    // Per person-day seconds: 10, 20, 60, 120, 240, 300, 600 → median 120 s.
    expect(s.medianMinutes).toBe(2);
    expect(s.errorsPer1k).toBe(125);
  });

  it('feature adoption, sources, countries, share loop, budget', async () => {
    const s = await loadStats(sqliteRun(db), NOW, 30);
    expect(Object.fromEntries(s.adoption.map((row) => [row.family, row.people]))).toEqual({
      created: 2, repo_map: 0, ai: 1, agent: 1, share_link: 1, export: 2, code_panel: 0, shared_copied: 1,
    });
    expect(s.adoption.find((row) => row.family === 'created')?.share).toBe(0.4);
    expect(s.sources).toEqual([{ name: 'direct', people: 2 }, { name: 'github', people: 1 }, { name: 'hn', people: 1 }, { name: 'x', people: 1 }]);
    expect(s.countries).toEqual([{ name: 'DE', people: 2 }, { name: 'US', people: 2 }, { name: 'GB', people: 1 }]);
    expect(s.share).toEqual({ view: 1, edit: 0, sharedSessions: 1, copied: 1 });
    // Beacons since 09-15: A×2, C×2, D, F, and E's two (folded into one row) = 8.
    expect(s.budget).toEqual({ requests: 8, share: 8 / 10_000_000 });
  });

  it('day 1/7/30 retention and activation by source', async () => {
    const fresh = database();
    // G (hn) creates on day one and is back on day 1 and day 7; H (hn) and I (x) never return.
    beacon(fresh, '2026-10-01', 'G', '2026-10-01', 'hn', 'DE', { session: 1, created_draw: 1 });
    beacon(fresh, '2026-10-02', 'G', '2026-10-01', 'hn', 'DE', { session: 1 });
    beacon(fresh, '2026-10-08', 'G', '2026-10-01', 'hn', 'DE', { session: 1 });
    beacon(fresh, '2026-10-01', 'H', '2026-10-01', 'hn', 'US', { session: 1 });
    beacon(fresh, '2026-10-10', 'I', '2026-10-10', 'x', 'US', { session: 1 });
    const s = await loadStats(sqliteRun(fresh), NOW, 30);
    // Day 1: G, H, I old enough, G back → 1/3. Day 7: G, H (I is 4 days old) → 1/2. Day 30: nobody old enough.
    expect(s.dayRetention).toEqual([{ day: 1, size: 3, rate: 1 / 3 }, { day: 7, size: 2, rate: 0.5 }, { day: 30, size: 0, rate: null }]);
    expect(s.activationBySource).toEqual([{ name: 'hn', people: 2, activated: 1, rate: 0.5 }, { name: 'x', people: 1, activated: 0, rate: 0 }]);
  });


  it('PMF, pay votes, emails, thumbs, unread', async () => {
    const s = await loadStats(sqliteRun(db), NOW, 30);
    expect(s.pmf).toEqual({ very: 1, somewhat: 1, not: 1, total: 3, veryShare: 1 / 3 });
    expect(s.pay).toEqual({
      collaboration: 1, private_repos: 0, sync: 1, free: 1, history: 0, libraries: 0, private_links: 0, ai_included: 0, sso: 0,
      comments: 0, drift: 0, integrations: 0, branding: 0, self_host: 0,
    });
    expect(s.emails).toBe(2);
    expect(s.thumbs).toEqual([{ feature: 'ai', up: 1, down: 1 }]);
    expect(s.comments.map((row) => row.text)).toEqual([PAYLOAD]);
    // Unread looks back a year, whatever the range; the 09-20 row was read.
    expect(s.unread?.count).toBe(4);
    expect(s.unread?.items.map((row) => row.created_at.slice(0, 10))).toEqual(['2026-10-14', '2026-10-10', '2026-10-01', '2026-08-01']);
    const week = await loadStats(sqliteRun(db), NOW, 7);
    expect(week.pmf.total).toBe(1);
    expect(week.reach.active).toBe(3);
  });

  it('an empty database gives zeros and nulls, never NaN', async () => {
    const s = await loadStats(sqliteRun(database()), NOW, 90);
    expect(s.reach).toEqual({ dau: 0, wau: 0, mau: 0, avgDau: 0, stickiness: null, newThisWeek: 0, active: 0 });
    expect([s.activation.rate, s.sessionsPerPerson, s.medianMinutes, s.errorsPer1k, s.pmf.veryShare]).toEqual([null, null, null, null, null]);
    expect(JSON.stringify(s)).not.toMatch(/NaN|Infinity/);
  });

  it('Pro waitlist: who opened it, plans, fair prices and features, apart from the product prompt', async () => {
    const pro = database();
    beacon(pro, '2026-10-10', 'P', '2026-10-10', 'direct', 'DE', { session: 1, pro_opened: 2 });
    beacon(pro, '2026-10-12', 'P', '2026-10-10', 'direct', 'DE', { session: 1, pro_opened: 1 });
    beacon(pro, '2026-10-12', 'Q', '2026-10-12', 'direct', 'DE', { session: 1, pro_opened: 1 });
    beacon(pro, '2026-10-12', 'R', '2026-10-12', 'direct', 'DE', { session: 1 });
    feedback(pro, { created_at: '2026-10-10T11:00:00.000Z', kind: 'pro', plan: 'team', price: 12, pay: 'collaboration,sso', email: 'a@b.co' });
    feedback(pro, { created_at: '2026-10-11T11:00:00.000Z', kind: 'pro', plan: 'team', price: 40, email: 'e@f.co' });
    feedback(pro, { created_at: '2026-10-11T12:00:00.000Z', kind: 'pro', plan: 'team', price: 4, email: 'g@h.co' });
    feedback(pro, { created_at: '2026-10-12T11:00:00.000Z', kind: 'pro', plan: 'pro', pay: 'sync', email: 'c@d.co' });
    feedback(pro, { created_at: '2026-10-12T12:00:00.000Z', kind: 'product', pmf: 'very', pay: 'collaboration' });
    const s = await loadStats(sqliteRun(pro), NOW, 30);
    // P and Q opened it (P twice counts once); 4 entries (seeded without a beacon each), so the rate is 4 of 2.
    expect([s.pro.opened, s.pro.joined, s.pro.joinRate]).toEqual([2, 4, 2]);
    expect(s.pro.plans).toEqual({ pro: 1, team: 3, enterprise: 0 });
    // Prices 4, 12, 40 (one left it unanswered): median 12; 40 is the slider's top, in the last band.
    expect([s.pro.price.answered, s.pro.price.median]).toEqual([3, 12]);
    expect(s.pro.price.bands.map((band) => band.people)).toEqual([1, 0, 1, 0, 0, 1]);
    expect([s.pro.features.collaboration, s.pro.features.sso, s.pro.features.sync, s.pro.features.history]).toEqual([1, 1, 1, 0]);
    // The product prompt's votes stay its own.
    expect([s.pay.collaboration, s.pay.sso, s.pay.sync]).toEqual([1, 0, 0]);
    expect(s.unread?.items.map((row) => row.plan)).toEqual([null, 'pro', 'team', 'team', 'team']);
  });

  it('unread is null, and the rest still loads, without migration 0002', async () => {
    const old = new DatabaseSync(':memory:');
    old.exec(MIGRATIONS[0]);
    old.exec(MIGRATIONS[2]);
    old.exec(MIGRATIONS[3]);
    const s = await loadStats(sqliteRun(old), NOW, 30);
    expect(s.unread).toBeNull();
    expect(s.reach.mau).toBe(0);
  });

  it('inlineParams quotes values for wrangler and refuses a missing one', () => {
    expect(inlineParams({ sql: 'SELECT ? AS a, ? AS b', params: ["it's", 3] })).toBe("SELECT 'it''s' AS a, 3 AS b");
    expect(() => inlineParams({ sql: 'SELECT ?', params: [] })).toThrow(/missing parameter/);
  });
});

// ---- page and routes --------------------------------------------------------------------------------------------

describe('escaping', () => {
  it('escapes markup and both quote kinds', () => {
    expect(esc(PAYLOAD)).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; &#39;single&#39;');
    expect(esc('"><img src=x onerror=alert(1)>')).not.toMatch(/[<>"]/);
    expect(esc(null)).toBe('');
  });
});

class MemoryCache implements CacheLike {
  readonly entries = new Map<string, string>();
  async match(request: Request) { const body = this.entries.get(request.url); return body === undefined ? undefined : new Response(body); }
  async put(request: Request, response: Response) { this.entries.set(request.url, await response.text()); }
}

describe('stats worker', () => {
  let db: DatabaseSync;
  let env: Env;
  beforeEach(() => {
    db = database();
    seed(db);
    env = { DB: new SqliteD1(db), TEAM_DOMAIN: TEAM, POLICY_AUD: AUD };
  });
  const get = async (path = '/', headers: Record<string, string> = {}) =>
    handle(new Request(`https://stats.openflowkit.com${path}`, { headers }), env, { fetcher, now: () => NOW, jwks: new Map() });
  const signedIn = async () => ({ 'Cf-Access-Jwt-Assertion': await jwt() });
  const markRead = async (headers: Record<string, string>, before = '2026-10-10T10:00:00.000Z') =>
    handle(new Request('https://stats.openflowkit.com/read', {
      method: 'POST', body: new URLSearchParams({ before, range: '7' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    }), env, { fetcher, now: () => NOW, jwks: new Map() });
  const unreadDays = () => (db.prepare('SELECT substr(created_at, 1, 10) AS day FROM feedback WHERE read_at IS NULL ORDER BY created_at').all() as { day: string }[]).map((row) => row.day);

  it('403 with no data without a valid token, or with the vars unset', async () => {
    const responses = [await get(), await get('/', { 'Cf-Access-Jwt-Assertion': await jwt({ aud: ['other'] }) }), await get('/nope')];
    env = { ...env, TEAM_DOMAIN: '', POLICY_AUD: '' };
    responses.push(await get('/', await signedIn()));
    for (const response of responses) {
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).not.toContain('a@example.com');
      expect(body).not.toContain('Daily active');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('renders the page with security headers and every user string escaped', async () => {
    const response = await get('/?range=30', await signedIn());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'");
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const body = await response.text();
    expect(body).not.toContain('<script');
    expect(body).toContain(esc(PAYLOAD));
    expect(body).toContain('<a href="mailto:a@example.com">a@example.com</a>');
    expect(body).toContain('aria-current="page">30 days');
    expect(body).toContain('1,234');
    expect(body).not.toMatch(/NaN|Infinity|undefined/);
    // The sections in the spec's order.
    const order = ['Unread feedback', 'Headline', 'Daily active people', 'Retention', 'Activation', 'Feature adoption', 'Top sources',
      'Share loop', 'Product fit and money', 'Growth outside the app', 'Health'].map((title) => body.indexOf(`<h2>${title}`));
    expect(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1]))).toBe(true);
  });

  it('a hostile country, source or version is escaped too', async () => {
    beacon(db, '2026-10-14', 'Z', '2026-10-14', '<img src=x onerror=alert(1)>', '"><b>', { session: 1 });
    db.prepare("UPDATE feedback SET version = '<i>v', country = '<u>' WHERE kind = 'product'").run();
    const body = await (await get('/', await signedIn())).text();
    expect(body).not.toContain('<img src=x');
    expect(body).not.toContain('"><b>');
    expect(body).not.toContain('<i>v');
    expect(body).not.toContain('<u>');
  });

  it('an empty database renders cleanly: dashes, no NaN', async () => {
    env = { ...env, DB: new SqliteD1(database()) };
    growthAnswers = {};
    for (const range of ['7', '30', '90', 'junk']) {
      const response = await get(`/?range=${range}`, await signedIn());
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toMatch(/NaN|Infinity|undefined|null/);
      expect(body).toContain('Nothing unread.');
      expect(body).toContain('—');
    }
  });

  it('mark all read needs the token and our own Origin, and marks only what the page showed', async () => {
    expect((await markRead({ Origin: 'https://stats.openflowkit.com' })).status).toBe(403);
    expect((await markRead({ ...await signedIn(), Origin: 'https://evil.example' })).status).toBe(403);
    expect((await markRead(await signedIn())).status).toBe(403);
    expect((await markRead({ ...await signedIn(), Origin: 'https://stats.openflowkit.com' }, 'yesterday')).status).toBe(400);
    expect(unreadDays()).toEqual(['2026-08-01', '2026-10-01', '2026-10-10', '2026-10-14']);
    const response = await markRead({ ...await signedIn(), Origin: 'https://stats.openflowkit.com' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/?range=7');
    // The 10-14 row arrived after the page's newest (10-10): it stays unread.
    expect(unreadDays()).toEqual(['2026-10-14']);
  });

  it('growth numbers: cached an hour, a failure shows — and is not cached', async () => {
    const cache = new MemoryCache();
    expect(await loadGrowth(fetcher, cache)).toEqual({ stars: 1234, npm: 54 });
    expect(await loadGrowth(fetcher, cache)).toEqual({ stars: 1234, npm: 54 });
    expect(fetched.filter((url) => url !== CERTS)).toHaveLength(2);
    growthAnswers[STARS] = () => new Response('rate limited', { status: 403 });
    growthAnswers[NPM] = () => Response.json({ error: 'not found' });
    const empty = new MemoryCache();
    expect(await loadGrowth(fetcher, empty)).toEqual({ stars: null, npm: null });
    expect(empty.entries.has(STARS)).toBe(false);
    const body = await (await get('/', await signedIn())).text();
    expect(body).toContain('GitHub stars</div><div class="tile-value">—');
  });
});

// ---- evidence ---------------------------------------------------------------------------------------------------

/** A plausible 90 days (deterministic): growth, churn, a few feedback rows. For the screenshots, not for assertions. */
function seedRealistic(db: DatabaseSync) {
  let state = 7;
  const random = () => { state = (state * 1_103_515_245 + 12_345) % 2 ** 31; return state / 2 ** 31; };
  const sources = ['direct', 'hn', 'github', 'x', 'reddit', 'google', 'producthunt'];
  const countries = ['US', 'DE', 'IN', 'GB', 'FR', 'BR', 'JP', 'CA', 'NL'];
  for (let day = 89; day >= 0; day -= 1) {
    const first = new Date(NOW.getTime() - day * 86_400_000).toISOString().slice(0, 10);
    const arrivals = Math.round(4 + (90 - day) / 8 + random() * 6 + (day === 40 ? 40 : 0));
    for (let n = 0; n < arrivals; n += 1) {
      const user = `${first}-${n}`;
      const source = day === 40 ? 'hn' : sources[Math.floor(random() ** 2 * sources.length)];
      const country = countries[Math.floor(random() ** 1.5 * countries.length)];
      const loyal = random();
      for (let later = day; later >= 0; later -= 1) {
        if (later !== day && random() > (loyal > 0.75 ? 0.45 : 0.04)) continue;
        const active = new Date(NOW.getTime() - later * 86_400_000).toISOString().slice(0, 10);
        beacon(db, active, user, first, source, country, {
          session: 1 + Math.floor(random() * 2), created_draw: random() < 0.5 ? 1 : 0, created_template: random() < 0.2 ? 1 : 0,
          created_code: random() < 0.15 ? 1 : 0, repo_map_ok: random() < 0.08 ? 1 : 0, ai_applied: random() < 0.12 ? 1 : 0,
          agent_mcp: random() < 0.05 ? 1 : 0, share_view: random() < 0.07 ? 1 : 0, share_edit: random() < 0.03 ? 1 : 0,
          export_image: random() < 0.25 ? 1 : 0, code_opened: random() < 0.3 ? 1 : 0, shared_copied: random() < 0.02 ? 1 : 0,
          app_error: random() < 0.01 ? 1 : 0, active_seconds: Math.round(60 + random() * 1500),
        }, random() < 0.05 ? 'shared' : 'home');
      }
    }
  }
  seed(db);
  feedback(db, { created_at: '2026-10-13T18:22:00.000Z', kind: 'feature', feature: 'repo_map', rating: 'up', text: 'The repo map found our three services and the queue between them. Would love private repos.', email: 'dev@example.com', pay: 'private_repos' });
  feedback(db, { created_at: '2026-10-12T08:05:00.000Z', kind: 'product', pmf: 'very', pay: 'collaboration' });
}

describe('evidence', () => {
  it('writes the seeded page for a look in a browser', async () => {
    const db = database();
    seedRealistic(db);
    const growth: Growth = { stars: 1234, npm: 54 };
    const html = renderPage(await loadStats(sqliteRun(db), NOW, 30), growth);
    expect(html).not.toMatch(/NaN|Infinity|undefined/);
    const dir = new URL('../docs/evidence/stats/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL('dashboard-seeded.html', dir), html);
    writeFileSync(new URL('dashboard-empty.html', dir), renderPage(await loadStats(sqliteRun(database()), NOW, 30), { stars: null, npm: null }));
  });
});

describe('usage storage: one row per person per day, a 100-day window', () => {
  it('a second beacon the same day adds its counts and keeps the first source', () => {
    const db = database();
    beacon(db, '2026-10-14', 'A', '2026-10-14', 'hn', 'DE', { session: 1, created_draw: 1, active_seconds: 60 });
    beacon(db, '2026-10-14', 'A', '2026-10-14', 'x', 'US', { session: 1, active_seconds: 30 });
    beacon(db, '2026-10-15', 'A', '2026-10-14', 'x', 'US', { session: 1 });
    expect(db.prepare('SELECT day, source, country, session, created_draw, active_seconds, beacons FROM sessions ORDER BY day').all()
      .map((row) => ({ ...row }))).toEqual([
      { day: '2026-10-14', source: 'hn', country: 'DE', session: 2, created_draw: 1, active_seconds: 90, beacons: 2 },
      { day: '2026-10-15', source: 'x', country: 'US', session: 1, created_draw: 0, active_seconds: 0, beacons: 1 },
    ]);
  });

  it('the nightly fold keeps one usage_daily row per old day and drops its detail rows; recent days stay', async () => {
    const db = database();
    const old = '2026-07-01'; // more than KEEP_USAGE_DAYS before NOW
    beacon(db, old, 'A', old, 'hn', 'DE', { session: 2, created_draw: 1 });
    beacon(db, old, 'B', '2026-06-01', 'x', 'US', { session: 1 });
    beacon(db, '2026-10-14', 'A', old, 'hn', 'DE', { session: 1 });
    await pruneUsage(new SqliteD1(db), NOW);
    expect(KEEP_USAGE_DAYS).toBe(100);
    expect(db.prepare('SELECT day FROM sessions').all().map((row) => row.day)).toEqual(['2026-10-14']);
    const [daily] = db.prepare('SELECT day, people, new_people, totals FROM usage_daily').all();
    expect({ ...daily, totals: undefined }).toEqual({ day: old, people: 2, new_people: 1, totals: undefined });
    expect(JSON.parse(String(daily!.totals))).toMatchObject({ session: 3, created_draw: 1, beacons: 2 });
    await pruneUsage(new SqliteD1(db), NOW); // nothing left to fold; the summary is not doubled
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_daily').all()[0]!.n).toBe(1);
  });
});
