// The Pro waitlist: a door to plans that aren't built yet, to learn what's worth paying for. It says waitlist everywhere
// and takes no payment. Three short steps beside a live picture of Pro (two people drawing together); the answer goes to
// /feedback as kind 'pro' and the stats page counts it.
import { useEffect, useId, useRef, useState } from 'react';
import {
  IconArrowLeft, IconArrowRight, IconBooks, IconBrandGithub, IconBrandSlack, IconCheck, IconDevices, IconGitPullRequest,
  IconHistory, IconLink, IconLock, IconMessageCircle, IconServer, IconShieldLock, IconSparkles, IconStar, IconUsersGroup,
  IconWorldWww, type Icon as TablerIcon,
} from '@tabler/icons-react';
import { FeedbackError, MAX_FEEDBACK_EMAIL, sendFeedback } from '../../../services/feedback/feedbackClient';
import { APP_VERSION, track } from '../../../services/usage/usage';
import { MAX_PRO_PRICE, type PayOption, type ProPlan } from '../../../services/usage/usageEvents';
import { Button, Dialog, Field, Icon } from '../design-system';
import { REPO_URL } from './homeStars';

const JOINED_KEY = 'ofk.pro';

interface Plan {
  readonly plan: ProPlan; readonly name: string; readonly who: string;
  readonly price: number | null; readonly founding: number | null; readonly per: string; readonly perks: readonly string[];
}
const PLANS: readonly Plan[] = [
  { plan: 'pro', name: 'Pro', who: 'For engineers who diagram every week', price: 8, founding: 6, per: 'a month',
    perks: ['Your diagrams on every device', 'Restore any past version', 'Built-in AI, nothing to set up', 'Live maps of your private repos', 'Embeds without our badge'] },
  { plan: 'team', name: 'Team', who: 'For teams that design systems together', price: 12, founding: 9, per: 'a person, a month',
    perks: ['Everything in Pro, for everyone', 'Live cursors, comments, mentions', 'Shared icons and templates', 'Links with password and expiry', 'Drift alerts on every pull request'] },
  { plan: 'enterprise', name: 'Enterprise', who: 'For companies with security reviews', price: null, founding: null, per: '',
    perks: ['SSO, SAML and audit logs', 'Self-host in your own cloud', 'Roles, permissions, admin controls', 'Confluence, Notion, Slack apps', 'Priority support with an SLA'] },
];
const FEATURES: readonly (readonly [Exclude<PayOption, 'free'>, string, TablerIcon])[] = [
  ['collaboration', 'Real-time collaboration', IconUsersGroup], ['comments', 'Comments and mentions', IconMessageCircle],
  ['sync', 'Sync across devices', IconDevices], ['history', 'Version history', IconHistory],
  ['ai_included', 'AI included', IconSparkles], ['libraries', 'Team libraries', IconBooks],
  ['private_links', 'Private share links', IconLink], ['private_repos', 'Private repo maps', IconBrandGithub],
  ['drift', 'Drift alerts on PRs', IconGitPullRequest], ['integrations', 'Notion, Confluence, Slack', IconBrandSlack],
  ['branding', 'Unbranded embeds', IconWorldWww], ['sso', 'SSO and audit logs', IconShieldLock], ['self_host', 'Self-hosted', IconServer],
];
const STEPS = ['Plan', 'What matters', 'Your spot'] as const;
const PRICE_START = 10;

/** The plan this browser joined the waitlist with, or null. */
export function joinedProPlan(): ProPlan | null {
  try {
    const value = localStorage.getItem(JOINED_KEY);
    return PLANS.some(({ plan }) => plan === value) ? value as ProPlan : null;
  } catch { return null; }
}

const money = (dollars: number) => (dollars >= MAX_PRO_PRICE ? `$${MAX_PRO_PRICE}+` : `$${dollars}`);

/** Pro, pictured: a small diagram drawing itself while two named cursors work on it. Decoration only. */
function ProScene(): React.JSX.Element {
  return (
    <svg className="ofk-pro-scene" viewBox="0 0 300 190" aria-hidden="true">
      <defs>
        <pattern id="ofk-pro-dots" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" /></pattern>
      </defs>
      <rect className="ofk-pro-scene-grid" width="300" height="190" fill="url(#ofk-pro-dots)" />
      <path className="ofk-pro-edge" pathLength="1" d="M84 58 C 120 58, 120 98, 150 98" />
      <path className="ofk-pro-edge ofk-pro-edge-2" pathLength="1" d="M210 98 C 236 98, 236 140, 258 140" />
      <path className="ofk-pro-edge ofk-pro-edge-3" pathLength="1" d="M84 138 C 116 138, 118 104, 150 100" />
      <g className="ofk-pro-node ofk-pro-node-1"><rect x="18" y="40" width="66" height="36" rx="9" /><rect className="ofk-pro-line" x="30" y="55" width="40" height="5" rx="2.5" /></g>
      <g className="ofk-pro-node ofk-pro-node-2"><rect x="18" y="120" width="66" height="36" rx="9" /><rect className="ofk-pro-line" x="30" y="135" width="30" height="5" rx="2.5" /></g>
      <g className="ofk-pro-node ofk-pro-node-3 ofk-pro-node-main"><rect x="150" y="78" width="60" height="42" rx="10" /><rect className="ofk-pro-line" x="162" y="95" width="36" height="5" rx="2.5" /><rect className="ofk-pro-line ofk-pro-line-soft" x="162" y="104" width="22" height="4" rx="2" /></g>
      <g className="ofk-pro-node ofk-pro-node-4"><rect x="226" y="124" width="64" height="34" rx="9" /><rect className="ofk-pro-line" x="238" y="138" width="34" height="5" rx="2.5" /></g>
      <g className="ofk-pro-cursor ofk-pro-cursor-you">
        <path d="M0 0 L0 13 L3.6 9.6 L6.4 15.4 L8.6 14.4 L5.8 8.8 L10.6 8.4 Z" />
        <g transform="translate(10 14)"><rect width="30" height="15" rx="7.5" /><text x="15" y="10.6">You</text></g>
      </g>
      <g className="ofk-pro-cursor ofk-pro-cursor-mate">
        <path d="M0 0 L0 13 L3.6 9.6 L6.4 15.4 L8.6 14.4 L5.8 8.8 L10.6 8.4 Z" />
        <g transform="translate(10 14)"><rect width="34" height="15" rx="7.5" /><text x="17" y="10.6">Maya</text></g>
      </g>
      <g className="ofk-pro-comment"><rect x="214" y="44" width="70" height="24" rx="12" /><circle cx="228" cy="56" r="6" /><rect className="ofk-pro-line" x="239" y="53.5" width="34" height="5" rx="2.5" /></g>
    </svg>
  );
}

export function V2ProWaitlist({ open, onClose, onJoined }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onJoined: (plan: ProPlan) => void;
}): React.JSX.Element {
  const [joined, setJoined] = useState<ProPlan | null>(joinedProPlan);
  const [step, setStep] = useState(0);
  const [plan, setPlan] = useState<ProPlan | null>(null);
  const [features, setFeatures] = useState<readonly PayOption[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => { if (open) track('pro_opened'); }, [open]);
  // Each step starts at its first control, so the keyboard flows on.
  useEffect(() => {
    if (step > 0) panel.current?.querySelector<HTMLElement>('input, button[aria-pressed]')?.focus();
  }, [step]);

  const chosen = PLANS.find((entry) => entry.plan === (joined ?? plan)) ?? null;
  // The slider starts at the plan's founding price, so there is always a number to agree with or move.
  // ponytail: that anchors answers near our price; start it at PRICE_START if the survey needs an unprimed answer.
  const fair = price ?? chosen?.founding ?? PRICE_START;
  const ready = [plan !== null, true, email.trim() !== ''][step]!;
  const next = () => {
    if (!ready || sending) return;
    if (step < STEPS.length - 1) { setStep(step + 1); return; }
    setSending(true);
    setError(null);
    sendFeedback({
      kind: 'pro', plan: plan!, price: fair, ...(features.length ? { pay: features } : {}), email, version: APP_VERSION,
    }).then(() => {
      try { localStorage.setItem(JOINED_KEY, plan!); } catch { /* the thanks still shows; the sidebar just won't remember */ }
      setJoined(plan);
      onJoined(plan!);
    }, (failure: unknown) => setError(failure instanceof FeedbackError ? failure.message : 'Couldn’t save your spot just now. Try again in a minute.'))
      .finally(() => setSending(false));
  };

  const hero = (
    <aside className="ofk-pro-hero">
      <span className="ofk-pro-badge"><i />Founding members</span>
      <h3>OpenFlowKit <em>Pro</em></h3>
      <p>Your architecture, always current and shared with your team. Not built yet, so you decide what comes first.</p>
      <ProScene />
      <ul className="ofk-pro-perks">
        <li><Icon icon={IconCheck} />Founding price, locked for life</li>
        <li><Icon icon={IconCheck} />In before everyone else</li>
        <li><Icon icon={IconCheck} />A real say in what we build first</li>
      </ul>
      <p className="ofk-pro-hero-foot"><Icon icon={IconLock} />Everything you use today stays free and open source.</p>
    </aside>
  );

  if (joined && chosen) {
    const issued = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return (
      <Dialog open={open} onClose={onClose} title="You’re on the list">
        <div className="ofk-pro" data-done="">
          {hero}
          <div className="ofk-pro-panel ofk-pro-done">
            <div className="ofk-pro-ticket" aria-hidden="true">
              <div className="ofk-pro-ticket-main">
                <span className="ofk-pro-ticket-kicker">OpenFlowKit {chosen.name}</span>
                <strong>Founding member</strong>
                <span>{chosen.founding ? `$${chosen.founding} ${chosen.per}, for life` : 'First in line, first call'}</span>
              </div>
              <div className="ofk-pro-ticket-stub"><span>Issued</span><b>{issued}</b></div>
              <span className="ofk-pro-stamp">Waitlist</span>
            </div>
            <h4>You’re on the list.</h4>
            <p>Here’s the deal: if enough of you raise a hand, we build it, and your founding price is yours for life.
              One email when it opens. Nothing else.</p>
            <div className="ofk-pro-actions">
              <a className="ofk-button" data-variant="secondary" href={REPO_URL} target="_blank" rel="noreferrer">
                <Icon icon={IconStar} /> Star us while you wait
              </a>
              <Button variant="primary" onClick={onClose}>Back to drawing</Button>
            </div>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="OpenFlowKit Pro">
      <form className="ofk-pro" onSubmit={(event) => { event.preventDefault(); next(); }}>
        {hero}
        <div className="ofk-pro-panel" ref={panel}>
          <ol className="ofk-pro-steps" aria-label="Steps">
            {STEPS.map((label, index) => (
              <li key={label} aria-current={index === step ? 'step' : undefined} data-done={index < step || undefined}>
                <span>{index < step ? <Icon icon={IconCheck} /> : index + 1}</span>{label}
              </li>
            ))}
          </ol>

          <div className="ofk-pro-step" key={step}>
            {step === 0 ? (
              <div className="ofk-pro-plans" role="radiogroup" aria-label="Plan">
                {PLANS.map((entry) => (
                  <label key={entry.plan} className="ofk-pro-plan" data-selected={plan === entry.plan || undefined}>
                    <input type="radio" name={`${id}-plan`} value={entry.plan} checked={plan === entry.plan}
                      onChange={() => setPlan(entry.plan)} />
                    <span className="ofk-pro-radio" aria-hidden="true" />
                    <span className="ofk-pro-plan-head">
                      <strong>{entry.name}</strong>
                      <small>{entry.who}</small>
                    </span>
                    <span className="ofk-pro-plan-price">
                      {entry.price !== null && entry.founding !== null ? <>
                        <s>${entry.price}</s><b>${entry.founding}</b><small>{entry.per}</small>
                      </> : <b className="ofk-pro-plan-talk">Let’s talk</b>}
                    </span>
                    <ul>{entry.perks.map((perk) => <li key={perk}><Icon icon={IconCheck} />{perk}</li>)}</ul>
                  </label>
                ))}
              </div>
            ) : null}

            {step === 1 ? <>
              <fieldset className="ofk-pro-features">
                <legend>What would you pay for? <small>Pick any</small></legend>
                <div>
                  {FEATURES.map(([value, label, glyph]) => (
                    <button key={value} type="button" className="ofk-pro-chip" aria-pressed={features.includes(value)}
                      onClick={() => setFeatures((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]))}>
                      <Icon icon={features.includes(value) ? IconCheck : glyph} />{label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="ofk-pro-price">
                <label htmlFor={`${id}-price`}>What would feel fair, per person a month?</label>
                <output htmlFor={`${id}-price`}><b>{money(fair)}</b> a month</output>
                <input id={`${id}-price`} type="range" min={0} max={MAX_PRO_PRICE} step={1} value={fair}
                  aria-valuetext={`${money(fair)} a month`}
                  style={{ '--ofk-pro-fill': `${(100 * fair) / MAX_PRO_PRICE}%` } as React.CSSProperties}
                  onChange={(event) => setPrice(Number(event.target.value))} />
                <div className="ofk-pro-price-scale" aria-hidden="true"><span>$0</span><span>${MAX_PRO_PRICE / 2}</span><span>${MAX_PRO_PRICE}+</span></div>
              </div>
            </> : null}

            {step === 2 ? <>
              <div className="ofk-pro-summary">
                <span>{chosen?.name}</span>
                <span>{chosen?.founding ? `$${chosen.founding} founding` : 'Let’s talk'}</span>
                <span>{features.length ? `${features.length} must-have${features.length === 1 ? '' : 's'}` : 'No picks'}</span>
                <span>{money(fair)} feels fair</span>
              </div>
              <Field label="Where should we send your invite?" type="email" autoComplete="email" maxLength={MAX_FEEDBACK_EMAIL}
                placeholder="you@company.com" hint="No payment now. One email when Pro opens, never shared."
                value={email} onChange={(event) => setEmail(event.target.value)} />
              {error ? <p className="ofk-pro-error" role="alert">{error}</p> : null}
              <ol className="ofk-pro-next" aria-label="What happens next">
                <li><b>You’re in line</b><span>Your spot and founding price are saved.</span></li>
                <li><b>We build what you asked for</b><span>The features most of you pick go first.</span></li>
                <li><b>You get the first invite</b><span>One email, before anyone else. Then you decide.</span></li>
              </ol>
            </> : null}
          </div>

          <footer className="ofk-pro-nav">
            {step > 0
              ? <Button variant="quiet" onClick={() => setStep(step - 1)}><Icon icon={IconArrowLeft} /> Back</Button>
              : <Button variant="quiet" onClick={onClose}>Not now</Button>}
            <Button type="submit" variant="primary" busy={sending} disabled={!ready || sending}>
              {step < STEPS.length - 1 ? <>Continue <Icon icon={IconArrowRight} /></> : <><Icon icon={IconSparkles} /> Claim my founding spot</>}
            </Button>
          </footer>
        </div>
      </form>
    </Dialog>
  );
}
