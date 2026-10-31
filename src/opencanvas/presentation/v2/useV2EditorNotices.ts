import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { runV1Import } from '../../../services/storage/v2/v1Import';
import type { ToastItem } from '../design-system';

// One import run per page load, so one notice per page load, whichever editor mounts first.
let v1NoticeShown = false;

/** Toasts the editor owes on mount: the v1 import outcome, and (dev only) uncaught errors. */
export function useV2EditorNotices(pushToast: (toast: ToastItem) => void): void {
  const navigate = useNavigate();

  // Dev only: an uncaught error is a bug, so it must not fail silently while
  // testing by hand. Production stays quiet (extensions throw into the page too).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const show = (message: string) =>
      pushToast({ id: `dev-error-${Date.now()}`, tone: 'danger', title: 'Uncaught error (dev)', description: message });
    const onError = (event: ErrorEvent) => show(event.message);
    const onRejection = (event: PromiseRejectionEvent) =>
      show(event.reason instanceof Error ? event.reason.message : String(event.reason));
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [pushToast]);

  // The one notice after v1 diagrams come over (12.4); later boots import nothing and stay quiet.
  // The v1 service-worker kill-switch reloads the tab seconds after the first visit, so the notice is
  // kept in storage and shown again after the reload until it has been on screen for a while.
  useEffect(() => {
    let live = true;
    const show = ({ imported, failed }: PendingNotice) => {
      if (v1NoticeShown) return;
      v1NoticeShown = true;
      const names = failed.slice(0, 3).map((name) => `“${name}”`).join(', ');
      pushToast({
        id: 'v1-import', tone: failed.length ? 'warning' : 'success', persistent: failed.length > 0,
        title: imported
          ? `Brought over ${imported} ${imported === 1 ? 'diagram' : 'diagrams'} from the previous editor`
          : 'Couldn’t bring over diagrams from the previous editor yet',
        ...(failed.length ? { description: `Not yet: ${names}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}. They stay safe in this browser.` } : {}),
        action: { label: 'See all diagrams', onClick: () => { clearPending(); navigate('/home'); } },
      });
      // Not cancelled on unmount: leaving the editor does not make it unseen.
      setTimeout(clearPending, SEEN_AFTER_MS);
    };
    const pending = readPending();
    if (pending) show(pending);
    runV1Import().then(({ imported, failures, firstRun }) => {
      // A failure that repeats on every boot is listed on Home, not toasted again.
      if (!live || v1NoticeShown || (imported.length === 0 && !(firstRun && failures.length))) return;
      const notice = { imported: imported.length, failed: failures.map((failure) => failure.name) };
      try { localStorage.setItem(PENDING_KEY, JSON.stringify(notice)); } catch { /* the toast still shows once */ }
      show(notice);
    }, () => undefined);
    return () => { live = false; };
  }, [pushToast, navigate]);
}

interface PendingNotice { readonly imported: number; readonly failed: readonly string[] }
const PENDING_KEY = 'ofk.v1ImportNotice';
const SEEN_AFTER_MS = 8000;
const clearPending = () => { try { localStorage.removeItem(PENDING_KEY); } catch { /* nothing stored */ } };
function readPending(): PendingNotice | null {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as Partial<PendingNotice> | null;
    return value && typeof value.imported === 'number' && Array.isArray(value.failed) ? { imported: value.imported, failed: value.failed.map(String) } : null;
  } catch {
    return null;
  }
}
