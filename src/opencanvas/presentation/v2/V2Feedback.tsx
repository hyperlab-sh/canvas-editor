// Feedback: the in-app prompt (in the feature tip's card, bottom right) and Help's Send feedback dialog. Presentation only:
// the rules live in services/feedback/promptRules, the post in feedbackClient.
import { useEffect, useId, useRef, useState } from 'react';
import { IconMessageCircle, IconThumbDown, IconThumbUp, IconX } from '@tabler/icons-react';
import { FeedbackError, MAX_FEEDBACK_EMAIL, MAX_FEEDBACK_TEXT, sendFeedback } from '../../../services/feedback/feedbackClient';
import type { FeedbackPrompt } from '../../../services/feedback/promptRules';
import { APP_VERSION } from '../../../services/usage/usage';
import type { FeedbackBody, FeedbackFeature, PayOption } from '../../../services/usage/usageEvents';
import { Button, Checkbox, Dialog, Field, Icon, IconButton, Popover, type ToastItem } from '../design-system';
import { useYielding } from './V2FeatureTip';
import type { V2PromptOutcome } from './useV2FeedbackPrompts';

const FEATURE_TITLE: Readonly<Record<FeedbackFeature, string>> = {
  repo_map: 'How was the repo map?',
  ai: 'How was the AI assistant?',
  agent: 'How was working with your agent?',
  export: 'How was the export?',
  share: 'How was the share link?',
};
const PMF = [['very', 'Very disappointed'], ['somewhat', 'Somewhat disappointed'], ['not', 'Not disappointed']] as const;
const PAY: readonly (readonly [PayOption, string])[] = [
  ['collaboration', 'Real-time collaboration'], ['private_repos', 'Private repos and PR checks, hosted'],
  ['sync', 'Sync across devices'], ['free', 'Nothing, free is great'],
];
const PRODUCT_STEPS = ['How would you feel if you could no longer use OpenFlowKit?', 'What would you pay for?', 'Want product updates? (optional)'];
/** The prompt sits above Help, bottom right: clear of the tools, the selection and the panels. */
const ANCHOR = '[role="toolbar"][aria-label="Help"] button';
/** Matches the exit fade in v2EditorPage.css. */
const LEAVE_MS = 140;

type Toast = (toast: ToastItem) => void;
const thanks = (onToast: Toast) => onToast({ id: 'feedback-sent', tone: 'success', title: 'Thanks — sent.' });
const failed = (onToast: Toast, error: unknown) => onToast({
  id: 'feedback-failed', tone: 'danger', title: 'Couldn’t send your feedback',
  description: error instanceof FeedbackError ? error.message : 'Try again in a minute.',
});

/**
 * One question at the idle moment after a success, or the product question on a third day. Passive like a tip: it never
 * takes focus on its own and steps aside from other floating UI. Closing before any answer is a dismissal; after one, what
 * was answered is sent.
 */
export function V2FeedbackPrompt({ prompt, hidden, onFinish, onToast }: {
  readonly prompt: FeedbackPrompt;
  /** The editor is busy (a panel, a menu, typing a label): out of sight, its answers kept. */
  readonly hidden: boolean;
  readonly onFinish: (outcome: V2PromptOutcome) => void;
  readonly onToast: Toast;
}): React.JSX.Element | null {
  const anchor = useRef<HTMLElement | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [found, setFound] = useState(false);
  useEffect(() => {
    anchor.current = document.querySelector<HTMLElement>(ANCHOR);
    setFound(anchor.current !== null);
  }, []);
  const yielding = useYielding(layer, found);
  const [step, setStep] = useState(0);
  const [rating, setRating] = useState<'up' | 'down' | null>(null);
  const [pmf, setPmf] = useState<(typeof PMF)[number][0] | null>(null);
  const [pay, setPay] = useState<readonly PayOption[]>([]);
  const [text, setText] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const textId = useId();

  const answered = prompt.kind === 'feature' ? rating !== null : pmf !== null;
  const body = (withWords: boolean): FeedbackBody => prompt.kind === 'feature'
    ? { kind: 'feature', feature: prompt.feature, rating: rating ?? 'up', version: APP_VERSION, ...(withWords && text.trim() ? { text } : {}) }
    : { kind: 'product', pmf: pmf ?? 'not', ...(pay.length ? { pay } : {}), version: APP_VERSION, ...(withWords && email.trim() ? { email } : {}) };
  const leave = (outcome: V2PromptOutcome) => {
    if (leaving) return;
    if (layer.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    setLeaving(true);
    window.setTimeout(() => onFinish(outcome), LEAVE_MS);
  };
  // What was answered goes quietly (no words, so no human check); a typed note waits for Send.
  const close = () => {
    if (answered) void sendFeedback(body(false)).catch(() => undefined);
    leave(answered ? 'answered' : 'dismissed');
  };
  const send = () => {
    setSending(true);
    sendFeedback(body(true)).then(() => { thanks(onToast); leave('answered'); }, (error: unknown) => { failed(onToast, error); setSending(false); });
  };
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });
  const out = hidden || yielding;
  // Escape puts it away; so does a press elsewhere before anything was answered. Neither is consumed.
  useEffect(() => {
    if (out) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    const onPointer = (event: PointerEvent) => {
      if (step === 0 && !layer.current?.contains(event.target as Node)) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [out, step]);
  if (!found) return null;

  const title = prompt.kind === 'product' ? PRODUCT_STEPS[step]! : step === 0 ? FEATURE_TITLE[prompt.feature] : 'What would make it better?';
  const never = <Button variant="quiet" className="ofk-v2-feedback-never" onClick={() => leave('never')}>Don’t ask again</Button>;
  return (
    <Popover open passive anchorRef={anchor} onClose={close} placement="top-end" gap={10}
      className="ofk-v2-tip ofk-v2-feedback" data-prompt={prompt.kind} data-leaving={leaving || undefined}
      style={out ? { visibility: 'hidden' } : undefined}>
      <section ref={layer} className="ofk-v2-tip-card" aria-label="Feedback" aria-live="polite">
        <div className="ofk-v2-tip-head">
          <span className="ofk-v2-tip-glyph" aria-hidden="true"><Icon icon={IconMessageCircle} /></span>
          <strong id={`${textId}-title`}>{title}</strong>
          <IconButton variant="quiet" label="Close" icon={<Icon icon={IconX} />} onClick={close} />
        </div>
        <div className="ofk-v2-feedback-step" key={step}>
          {prompt.kind === 'feature' && step === 0 ? (
            <div className="ofk-v2-feedback-row">
              <div className="ofk-v2-feedback-thumbs" role="group" aria-labelledby={`${textId}-title`}>
                <IconButton variant="secondary" label="Thumbs up" icon={<Icon icon={IconThumbUp} />} onClick={() => { setRating('up'); setStep(1); }} />
                <IconButton variant="secondary" label="Thumbs down" icon={<Icon icon={IconThumbDown} />} onClick={() => { setRating('down'); setStep(1); }} />
              </div>
              {never}
            </div>
          ) : null}
          {prompt.kind === 'feature' && step === 1 ? (
            <form className="ofk-v2-feedback-form" onSubmit={(event) => { event.preventDefault(); send(); }}>
              <textarea id={textId} className="ofk-v2-feedback-text" rows={3} autoFocus maxLength={MAX_FEEDBACK_TEXT}
                aria-labelledby={`${textId}-title`} placeholder="Optional" value={text} onChange={(event) => setText(event.target.value)} />
              <div className="ofk-v2-tip-actions">
                <Button type="submit" variant="primary" busy={sending} disabled={sending}>Send</Button>
              </div>
            </form>
          ) : null}
          {prompt.kind === 'product' && step === 0 ? (
            <>
              <div className="ofk-v2-feedback-choices" role="group" aria-labelledby={`${textId}-title`}>
                {PMF.map(([value, label]) => (
                  <Button key={value} variant="secondary" onClick={() => { setPmf(value); setStep(1); }}>{label}</Button>
                ))}
              </div>
              <div className="ofk-v2-feedback-row"><span className="ofk-v2-feedback-count">1 of 3</span>{never}</div>
            </>
          ) : null}
          {prompt.kind === 'product' && step === 1 ? (
            <>
              <div className="ofk-v2-feedback-checks" role="group" aria-labelledby={`${textId}-title`}>
                {PAY.map(([value, label]) => (
                  <Checkbox key={value} label={label} checked={pay.includes(value)}
                    onChange={(event) => setPay((current) => (event.target.checked ? [...current, value] : current.filter((item) => item !== value)))} />
                ))}
              </div>
              <div className="ofk-v2-feedback-row">
                <span className="ofk-v2-feedback-count">2 of 3</span>
                <Button variant="primary" onClick={() => setStep(2)}>Next</Button>
              </div>
            </>
          ) : null}
          {prompt.kind === 'product' && step === 2 ? (
            <form className="ofk-v2-feedback-form" onSubmit={(event) => { event.preventDefault(); send(); }}>
              <Field label="Email" type="email" autoFocus maxLength={MAX_FEEDBACK_EMAIL} placeholder="you@example.com"
                value={email} onChange={(event) => setEmail(event.target.value)} />
              <div className="ofk-v2-feedback-row">
                <span className="ofk-v2-feedback-count">3 of 3</span>
                <Button type="submit" variant="primary" busy={sending} disabled={sending}>Send</Button>
              </div>
            </form>
          ) : null}
        </div>
      </section>
    </Popover>
  );
}

/** Help → Send feedback: always there, whatever the prompt rules say. The note stays until it is sent. */
export function V2FeedbackDialog({ open, onClose, onToast }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onToast: Toast;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  // showModal() focuses the close button; the note is what people came for.
  useEffect(() => { if (open) field.current?.focus(); }, [open]);
  const send = () => {
    if (!text.trim() || sending) return;
    setSending(true);
    sendFeedback({ kind: 'general', text, ...(email.trim() ? { email } : {}), version: APP_VERSION }).then(() => {
      thanks(onToast);
      setText('');
      setEmail('');
      onClose();
    }, (error: unknown) => failed(onToast, error)).finally(() => setSending(false));
  };
  return (
    <Dialog open={open} onClose={onClose} title="Send feedback" description="Ideas, bugs, anything that got in your way."
      actions={<>
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={sending} disabled={!text.trim() || sending} onClick={send}>Send</Button>
      </>}>
      <div className="ofk-v2-feedback-form">
        <div className="ofk-field">
          <label htmlFor={id}>Your feedback</label>
          <textarea ref={field} id={id} className="ofk-v2-feedback-text" rows={5} maxLength={MAX_FEEDBACK_TEXT} value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } }} />
        </div>
        <Field label="Email (optional)" hint="Only if you’d like a reply." type="email" maxLength={MAX_FEEDBACK_EMAIL}
          value={email} onChange={(event) => setEmail(event.target.value)} />
      </div>
    </Dialog>
  );
}
