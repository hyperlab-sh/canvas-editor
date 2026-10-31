// The one contract between the app's usage counter and the share Worker's /e and /feedback routes.
// Each event is an INTEGER column of the D1 `sessions` table: append only (a new event = a new migration), never rename.

export const USAGE_EVENTS = [
  'session',
  'created_draw', 'created_template', 'created_code', 'created_ai', 'created_import', 'created_map',
  'repo_map_ok', 'repo_map_fail',
  'ai_applied',
  'agent_mcp', 'agent_webmcp',
  'share_view', 'share_edit',
  'export_image', 'export_data', 'export_motion',
  'code_opened',
  'prompt_shown', 'prompt_answered',
  /** A shared viewer pressed Edit in OpenFlowKit: the share loop turning a viewer into a user. */
  'shared_copied',
  /** Uncaught errors in the page: a quality signal, no message or stack is sent. */
  'app_error',
  /** Seconds the tab was visible with input in the last 60 s (engaged time, not open time). */
  'active_seconds',
  /** The Pro waitlist dialog opened (migration 0003). */
  'pro_opened',
] as const;
export type UsageEvent = (typeof USAGE_EVENTS)[number];

export const USAGE_ENTRIES = ['home', 'doc', 'shared', 'map'] as const;
export type UsageEntry = (typeof USAGE_ENTRIES)[number];

/** POST /e body (navigator.sendBeacon, text/plain JSON): counts since the last send. Sent on pagehide, and on
 *  visibilitychange → hidden at most once per 5 minutes, so a user costs a few Worker requests a day. */
export interface UsageBeacon {
  readonly v: 1;
  /** Random 32-hex install id from localStorage `ofk.usage.id`; no personal data. Deleted when stats are turned off. */
  readonly uid: string;
  /** UTC day (YYYY-MM-DD) this browser was first seen: the retention cohort. */
  readonly firstSeen: string;
  /** utm_source, else a referrer bucket (hn, producthunt, x, reddit, github, google, linkedin, other), else 'direct'. */
  readonly source: string;
  readonly entry: UsageEntry;
  readonly version: string;
  readonly returning: boolean;
  readonly counts: Partial<Record<UsageEvent, number>>;
}

export const FEEDBACK_FEATURES = ['repo_map', 'ai', 'agent', 'export', 'share'] as const;
export type FeedbackFeature = (typeof FEEDBACK_FEATURES)[number];
/** Append only: the dashboard counts each by name. The product prompt offers the first four; the Pro waitlist all but 'free'. */
export const PAY_OPTIONS = [
  'collaboration', 'private_repos', 'sync', 'free', 'history', 'libraries', 'private_links', 'ai_included', 'sso',
  'comments', 'drift', 'integrations', 'branding', 'self_host',
] as const;
export type PayOption = (typeof PAY_OPTIONS)[number];
/** Pro waitlist: the plan someone would join. */
export const PRO_PLANS = ['pro', 'team', 'enterprise'] as const;
export type ProPlan = (typeof PRO_PLANS)[number];
/** The fair-price slider's top, in whole dollars per person a month; the top means "this or more". */
export const MAX_PRO_PRICE = 40;

/** POST /feedback body (JSON). A text or email needs the X-Turnstile-Token header. 'pro' needs a plan and an email. */
export interface FeedbackBody {
  readonly kind: 'feature' | 'product' | 'general' | 'pro';
  readonly feature?: FeedbackFeature;
  readonly rating?: 'up' | 'down';
  /** "How would you feel if you could no longer use OpenFlowKit?" */
  readonly pmf?: 'very' | 'somewhat' | 'not';
  readonly pay?: readonly PayOption[];
  readonly plan?: ProPlan;
  /** Whole dollars per person a month that feel fair, 0..MAX_PRO_PRICE. */
  readonly price?: number;
  /** ≤ 2000 characters. */
  readonly text?: string;
  /** ≤ 254 characters. */
  readonly email?: string;
  readonly version: string;
}
