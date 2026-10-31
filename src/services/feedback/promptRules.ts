// When to ask for feedback: pure rules over a small stored state, a clock and this session's success moments.
import { FEEDBACK_FEATURES, type FeedbackFeature, type UsageEvent } from '../usage/usageEvents';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** No prompt this early in the first visit. */
export const FIRST_VISIT_QUIET_MS = 2 * MINUTE;
/** A success settles this long before it is asked about; the product question waits as long into a session. */
export const PROMPT_DELAY_MS = 20_000;
export const PROMPT_GAP_MS = 3 * DAY;
export const SNOOZE_MS = 30 * DAY;
const DISMISSALS_TO_SNOOZE = 2;
const PRODUCT_DAYS = 3;
const DAYS_KEPT = 10;

export interface FeedbackState {
  readonly firstVisitAt: number | null;
  readonly asked: readonly FeedbackFeature[];
  readonly lastPromptAt: number | null;
  readonly dismissals: number;
  readonly snoozedUntil: number | null;
  readonly never: boolean;
  /** Local YYYY-MM-DD, newest last, at most DAYS_KEPT. */
  readonly activeDays: readonly string[];
  readonly productAsked: boolean;
}

export const EMPTY_FEEDBACK_STATE: FeedbackState = {
  firstVisitAt: null, asked: [], lastPromptAt: null, dismissals: 0, snoozedUntil: null, never: false, activeDays: [], productAsked: false,
};

export type FeedbackPrompt = { readonly kind: 'feature'; readonly feature: FeedbackFeature } | { readonly kind: 'product' };

export interface PromptContext {
  readonly sessionStartedAt: number;
  /** This session's success moments, by feature. */
  readonly successes: Partial<Record<FeedbackFeature, number>>;
}

export function featureOf(event: UsageEvent): FeedbackFeature | null {
  if (event === 'repo_map_ok') return 'repo_map';
  if (event === 'ai_applied') return 'ai';
  if (event === 'agent_mcp' || event === 'agent_webmcp') return 'agent';
  if (event.startsWith('export_')) return 'export';
  if (event === 'share_view' || event === 'share_edit') return 'share';
  return null;
}

const dayOf = (time: number): string => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/** The prompt due now, or null. A fresh success is asked about first; the product question comes on a 3rd active day. */
export function nextPrompt(state: FeedbackState, now: number, context: PromptContext): FeedbackPrompt | null {
  if (state.never || (state.snoozedUntil !== null && now < state.snoozedUntil)) return null;
  if (state.firstVisitAt === null || now - state.firstVisitAt < FIRST_VISIT_QUIET_MS) return null;
  if (state.lastPromptAt !== null && now - state.lastPromptAt < PROMPT_GAP_MS) return null;
  const due = FEEDBACK_FEATURES
    .filter((feature) => !state.asked.includes(feature))
    .flatMap((feature) => {
      const at = context.successes[feature];
      return at !== undefined && now - at >= PROMPT_DELAY_MS ? [{ feature, at }] : [];
    })
    .sort((a, b) => a.at - b.at)[0];
  if (due) return { kind: 'feature', feature: due.feature };
  if (!state.productAsked && new Set(state.activeDays).size >= PRODUCT_DAYS && now - context.sessionStartedAt >= PROMPT_DELAY_MS) return { kind: 'product' };
  return null;
}

/** When `nextPrompt` may next change its answer on its own (a success settling, the quiet minutes ending); null when only an event can. */
export function nextCheckAt(state: FeedbackState, now: number, context: PromptContext): number | null {
  const times = [
    state.firstVisitAt !== null ? state.firstVisitAt + FIRST_VISIT_QUIET_MS : null,
    context.sessionStartedAt + PROMPT_DELAY_MS,
    ...Object.values(context.successes).map((at) => at + PROMPT_DELAY_MS),
  ].filter((time): time is number => time !== null && time > now);
  return times.length ? Math.min(...times) : null;
}

export function recordSession(state: FeedbackState, now: number): FeedbackState {
  const day = dayOf(now);
  return {
    ...state,
    firstVisitAt: state.firstVisitAt ?? now,
    activeDays: state.activeDays.includes(day) ? state.activeDays : [...state.activeDays, day].slice(-DAYS_KEPT),
  };
}

/** Shown is asked: a feature is never asked twice, whatever the answer. */
export function recordShown(state: FeedbackState, prompt: FeedbackPrompt, now: number): FeedbackState {
  return {
    ...state,
    lastPromptAt: now,
    ...(prompt.kind === 'feature' ? { asked: [...new Set([...state.asked, prompt.feature])] } : { productAsked: true }),
  };
}

export function recordDismissed(state: FeedbackState, now: number): FeedbackState {
  const dismissals = state.dismissals + 1;
  return dismissals >= DISMISSALS_TO_SNOOZE ? { ...state, dismissals: 0, snoozedUntil: now + SNOOZE_MS } : { ...state, dismissals };
}

export const recordAnswered = (state: FeedbackState): FeedbackState => ({ ...state, dismissals: 0 });
export const recordNever = (state: FeedbackState): FeedbackState => ({ ...state, never: true });

const FEEDBACK_KEY = 'ofk.feedback';
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Stored state; anything unreadable reads as a fresh start. */
export function readFeedbackState(storage: Pick<Storage, 'getItem'> | null): FeedbackState {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(FEEDBACK_KEY) ?? '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch { /* fresh start */ }
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  return {
    firstVisitAt: isTime(raw.firstVisitAt) ? raw.firstVisitAt : null,
    asked: list(raw.asked).filter((item): item is FeedbackFeature => (FEEDBACK_FEATURES as readonly unknown[]).includes(item)),
    lastPromptAt: isTime(raw.lastPromptAt) ? raw.lastPromptAt : null,
    dismissals: isTime(raw.dismissals) ? raw.dismissals : 0,
    snoozedUntil: isTime(raw.snoozedUntil) ? raw.snoozedUntil : null,
    never: raw.never === true,
    activeDays: list(raw.activeDays).filter((day): day is string => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)).slice(-DAYS_KEPT),
    productAsked: raw.productAsked === true,
  };
}

export function writeFeedbackState(storage: Pick<Storage, 'setItem'> | null, state: FeedbackState): void {
  try { storage?.setItem(FEEDBACK_KEY, JSON.stringify(state)); } catch { /* blocked: this page load still remembers */ }
}
