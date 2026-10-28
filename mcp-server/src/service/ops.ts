import { findAgentOp, runAgentOp } from '../lib/agent.js';
import { loadFileCapabilities } from '../lib/fileCapabilities.js';
import type { Sessions } from './sessions.js';
import type { Store } from './store.js';

/** A write that lost the race to a tab's save is redone on the newer document this many times. */
const ATTEMPTS = 3;

export type OpOutcome =
  | { readonly status: 200; readonly ok: true; readonly output: unknown }
  | { readonly status: 400 | 404 | 409; readonly ok: false; readonly error: string; readonly holder?: string | null };

export interface OpRequest {
  readonly project: string;
  readonly id: string;
  readonly op: string;
  readonly input: unknown;
  readonly pageId?: string;
}

/**
 * Runs one op for a session on a diagram it holds and writes the result (AC-7).
 * A session with no hold on the diagram changes nothing (D5).
 */
export async function runOp(sessions: Sessions, store: Store, sessionId: string, request: OpRequest): Promise<OpOutcome> {
  const session = sessions.get(sessionId);
  if (!session) return { status: 404, ok: false, error: `Unknown session ${sessionId}. Register again.` };
  sessions.touch(sessionId);
  const { project, id } = request;
  const holder = sessions.holderOf(project, id);
  if (holder?.id !== sessionId) {
    return {
      status: 409, ok: false, holder: holder?.label ?? null,
      error: holder
        ? `${project}/${id} is connected to ${holder.label}. Ask the user to disconnect it first.`
        : `This session is not connected to ${project}/${id}. Connect it first.`,
    };
  }
  const op = findAgentOp(request.op);
  if (!op) return { status: 400, ok: false, error: `Unknown op "${request.op}".` };
  const capabilities = await loadFileCapabilities();
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const current = await store.read(project, id);
    const pageId = request.pageId ?? current.document.pages[0]?.id ?? '';
    let result;
    try {
      result = await runAgentOp(op, request.input, { document: current.document, pageId, capabilities, client: session.client });
    } catch (error) {
      return { status: 400, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!result.changed) return { status: 200, ok: true, output: result.output };
    const written = await store.write(project, id, result.document, current.revision);
    if (written.status === 'ok') return { status: 200, ok: true, output: result.output };
  }
  return { status: 409, ok: false, error: 'The diagram kept changing under the op; try it again.' };
}
