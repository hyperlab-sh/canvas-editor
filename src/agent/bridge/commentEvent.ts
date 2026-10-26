// The editor's one way to volunteer a comment to the agent session that owns the bridge (POST /event).
// The bridge hook points it at the live connection while paired, so a caller needs no port or token.
import type { BridgeCommentEvent } from './protocol';

let send: ((event: BridgeCommentEvent) => Promise<unknown>) | null = null;

/** Set by the bridge hook while this tab is connected, null otherwise. */
export function setCommentEventSender(next: typeof send): void {
  send = next;
}

/** Pushes a new human comment message to the paired agent session; resolves false (never throws) when not connected or refused. */
export async function postCommentEvent(event: BridgeCommentEvent): Promise<boolean> {
  if (!send) return false;
  try {
    await send(event);
    return true;
  } catch {
    return false;
  }
}
