import type { HTMLAttributes, Ref } from 'react';
import { IconSparkles } from '@tabler/icons-react';
import { Button } from './Button';
import { Icon } from './Icon';
import { Status } from './Status';
export type AgentState = 'disconnected' | 'idle' | 'working' | 'waiting';
/** Connection + activity in one glance. Never the visual center; lives in the document bar. */
export function AgentBadge({
  name,
  state,
  detail,
  onClick,
}: {
  name: string;
  state: AgentState;
  detail?: string;
  onClick?: () => void;
}) {
  const tone =
    state === 'working'
      ? 'info'
      : state === 'waiting'
        ? 'warning'
        : state === 'idle'
          ? 'success'
          : 'neutral';
  const body = (
    <span className="ofk-agent-badge" data-state={state}>
      <span className="ofk-agent-dot" aria-hidden="true" />
      <Status tone={tone} live={state === 'waiting'}>
        {name}
        {detail ? ` · ${detail}` : ''}
      </Status>
    </span>
  );
  return onClick ? (
    <Button variant="quiet" onClick={onClick}>
      {body}
    </Button>
  ) : (
    body
  );
}
/** Scope request from an agent. The host enforces the answer in the commit service; this only asks. */
export function PermissionPrompt({
  agent,
  request,
  onAllowOnce,
  onAllowSession,
  onDeny,
  labels,
}: {
  agent: string;
  request: string;
  onAllowOnce: () => void;
  onAllowSession: () => void;
  onDeny: () => void;
  labels?: Partial<Record<'title' | 'once' | 'session' | 'deny', string>>;
}) {
  const t = {
    title: 'requests access',
    once: 'Allow once',
    session: 'Allow this session',
    deny: 'Deny',
    ...labels,
  };
  return (
    <section
      className="ofk-permission ofk-overlay ofk-enter"
      role="alertdialog"
      aria-label={`${agent} ${t.title}`}
    >
      <div>
        <Status tone="warning" live>
          {agent} {t.title}
        </Status>
        <p>{request}</p>
      </div>
      <div className="ofk-permission-actions">
        <Button variant="quiet" onClick={onDeny}>
          {t.deny}
        </Button>
        <Button onClick={onAllowSession}>{t.session}</Button>
        <Button variant="primary" onClick={onAllowOnce} autoFocus>
          {t.once}
        </Button>
      </div>
    </section>
  );
}
/** Marks agent-authored objects in lists and inspectors. Decorative beside a label; labelled when alone. */
export function ProvenanceBadge({
  label = 'Made by agent',
  standalone = false,
}: {
  label?: string;
  standalone?: boolean;
}) {
  return (
    <span
      className="ofk-provenance"
      title={label}
      aria-label={standalone ? label : undefined}
      aria-hidden={standalone ? undefined : true}
    >
      <Icon icon={IconSparkles} />
    </span>
  );
}
/**
 * An agent's pointer on the canvas: a real arrow with its name in an offset pill. Its owner places it (style.transform,
 * the arrow's tip at the origin) and fades it; it never takes pointer events.
 */
export function AgentCursor({
  name,
  working = false,
  ref,
  ...rest
}: { name: string; working?: boolean; ref?: Ref<HTMLDivElement> } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div ref={ref} className="ofk-agent-cursor" aria-hidden="true" {...rest}>
      <svg className="ofk-agent-cursor-arrow" viewBox="0 0 20 22" width="20" height="22">
        <path d="M2.5 1.5v16.2l4.3-4 2.9 6.6 2.9-1.3-2.8-6.4h5.9z" />
      </svg>
      <span className="ofk-agent-cursor-pill">
        {name}
        {working ? <span className="ofk-agent-cursor-dots"><i /><i /><i /></span> : null}
      </span>
    </div>
  );
}
