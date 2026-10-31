import { useCallback, useEffect, useRef, useState } from 'react';
import { feedbackContext, feedbackState, onFeedbackSuccess, updateFeedbackState } from '../../../services/feedback/feedbackSession';
import {
  nextCheckAt, nextPrompt, recordAnswered, recordDismissed, recordNever, recordShown, type FeedbackPrompt,
} from '../../../services/feedback/promptRules';
import { track } from '../../../services/usage/usage';
import { isEditableTarget } from './pointerOperations';

export type V2PromptOutcome = 'answered' | 'dismissed' | 'never';

/** Open menus and dialogs, or a feature tip up; side panels the prompt steps aside from instead. */
const BUSY = '.ofk-popover:not([data-passive]), dialog[open], .ofk-v2-tip';
const NOT_IDLE_RETRY_MS = 2000;

/**
 * The feedback prompt due now, shown only on an idle canvas: no button held, no typing, nothing open.
 * `enabled` is false where nobody should be asked (a shared view, an embed); `blocked` while the editor is busy.
 */
export function useV2FeedbackPrompts({ enabled, blocked }: { readonly enabled: boolean; readonly blocked: boolean }) {
  const [prompt, setPrompt] = useState<FeedbackPrompt | null>(null);
  const [check, setCheck] = useState(0);
  const pressed = useRef(false);
  useEffect(() => {
    const down = () => { pressed.current = true; };
    const up = () => { pressed.current = false; };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    const stop = onFeedbackSuccess(() => setCheck((n) => n + 1));
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      stop();
    };
  }, []);

  useEffect(() => {
    if (!enabled || blocked || prompt) return;
    const now = Date.now();
    const state = feedbackState();
    const context = feedbackContext();
    const due = nextPrompt(state, now, context);
    const idle = !pressed.current && !isEditableTarget(document.activeElement) && !document.querySelector(BUSY) && window.innerWidth >= 600;
    // Asked only once the moment is quiet; otherwise look again when a rule or the canvas may have changed.
    const later = due ? null : nextCheckAt(state, now, context);
    if (!due && later === null) return;
    const wait = due ? (idle ? 0 : NOT_IDLE_RETRY_MS) : later! - now + 50;
    const timer = window.setTimeout(() => {
      if (!due || wait > 0) { setCheck((n) => n + 1); return; }
      updateFeedbackState((current) => recordShown(current, due, Date.now()));
      track('prompt_shown');
      setPrompt(due);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [enabled, blocked, prompt, check]);

  const finish = useCallback((outcome: V2PromptOutcome) => {
    updateFeedbackState((current) => (outcome === 'answered' ? recordAnswered(current)
      : outcome === 'never' ? recordNever(current) : recordDismissed(current, Date.now())));
    if (outcome === 'answered') track('prompt_answered');
    setPrompt(null);
  }, []);

  return { prompt, finish };
}
