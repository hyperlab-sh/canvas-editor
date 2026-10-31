import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { applyDocumentCommand } from '../../domain/commands/execute';
import type { DocumentCommand } from '../../domain/commands/types';
import { createEmptyV2Document, createEmptyV2Page } from './v2Document';
import { looksLikeDiagramCode, useV2CodeWorkspace } from './useV2CodeWorkspace';

// A converter that throws (the real ones return {error}, but a bug or a pathological input could throw).
vi.mock('../../../agent/lint', async (importActual) => {
  const actual = await importActual<typeof import('../../../agent/lint')>();
  return {
    ...actual,
    detectForeign: (text: string) => text === 'BOOM'
      ? { label: 'Test', convert: () => { throw new RangeError('Maximum call stack size exceeded'); } }
      : actual.detectForeign(text),
  };
});

const WORKSPACE = 'architecture\nmodel {\n  person Alice\n  system Shop { container Web }\n  Alice -> Shop\n}\nviews {\n  view landscape\n}\n';
const FLOW = 'flowchart\nStart -> Build -> Ship';

/** A document the hook edits for real: commits apply, the page on screen is `pageIndex`. */
function harness(pageCount = 2) {
  let document = createEmptyV2Document('d');
  for (let index = 1; index < pageCount; index += 1) {
    document = { ...document, pages: [...document.pages, createEmptyV2Page(`page-${index + 1}`)] };
  }
  const announce = vi.fn();
  const pushToast = vi.fn();
  const view = renderHook(({ index }: { index: number }) => {
    const page = document.pages[index]!;
    return useV2CodeWorkspace({
      document, page, pageRef: { current: page }, hostRef: { current: null }, readOnly: false, palette: 'pastel', autoIcons: false,
      onPaletteChange: () => undefined, commit: (command: DocumentCommand) => { document = applyDocumentCommand(document, command).document; view.rerender({ index }); },
      applySelection: () => undefined, fitView: () => undefined, openPanel: () => undefined, onViews: () => undefined,
      pushToast, dismissToast: () => undefined, announce,
    });
  }, { initialProps: { index: 0 } });
  return { view, announce, pushToast, doc: () => document };
}

describe('useV2CodeWorkspace follows the page', () => {
  it('a diagram bound on one page is not the target of Generate on another', async () => {
    const { view, doc } = harness();
    await act(async () => { await view.result.current.startFrom(FLOW, { openPanel: false }); });
    expect(view.result.current.frameId).not.toBeNull();
    const firstPage = doc().pages[0]!;
    view.rerender({ index: 1 });
    // The panel never says "edit that frame" on a page that does not hold it.
    expect(view.result.current.frameId).toBeNull();
    act(() => view.result.current.edit(WORKSPACE));
    await act(async () => { await view.result.current.generate(); });
    expect(doc().pages[0]).toEqual(firstPage);
    expect(doc().pages[1]!.nodes.length).toBeGreaterThan(0);
  });

  it('switching to a page with a diagram shows that diagram\'s source', async () => {
    const { view } = harness();
    await act(async () => { await view.result.current.startFrom(FLOW, { openPanel: false }); });
    view.rerender({ index: 1 });
    expect(view.result.current.frameId).toBeNull();
    view.rerender({ index: 0 });
    await waitFor(() => expect(view.result.current.frameId).not.toBeNull());
    expect(view.result.current.draft).toContain('Start');
  });
});

describe('useV2CodeWorkspace keeps what was typed', () => {
  it('a workspace with a bad relation line stays as written', async () => {
    const { view, doc } = harness(1);
    const bad = WORKSPACE.replace('  Alice -> Shop\n', '  Alice -> Shop\n  Alice -> Nobody\n');
    act(() => view.result.current.edit(bad));
    await act(async () => { await view.result.current.generate(); });
    expect(doc().pages[0]!.nodes.length).toBeGreaterThan(0);
    expect(view.result.current.draft).toBe(bad);
  });

  it('refuses a conversion the tokenizer would cut short', async () => {
    const { view, doc, announce } = harness(1);
    const lines = Array.from({ length: 20_005 }, (_, index) => `N${index}`).join('\n');
    act(() => view.result.current.edit(`flowchart\n${lines}`));
    let committed = true;
    await act(async () => { committed = await view.result.current.generate(); });
    expect(committed).toBe(false);
    expect(doc().pages[0]!.nodes).toHaveLength(0);
    expect(view.result.current.diagnostics.some((item) => item.message.includes('Too big'))).toBe(true);
    expect(announce).not.toHaveBeenCalledWith(expect.stringContaining('nodes generated'));
  });

  it('a converter that throws shows its error in the panel', () => {
    const { view } = harness(1);
    act(() => view.result.current.edit('BOOM'));
    expect(view.result.current.foreign).not.toBeNull();
    act(() => view.result.current.foreign?.convert());
    expect(view.result.current.diagnostics.map((item) => item.message)).toContain('Maximum call stack size exceeded');
    expect(view.result.current.draft).toBe('BOOM');
  });
});

describe('looksLikeDiagramCode', () => {
  it('takes Mermaid, D2, Structurizr and OpenFlowKit source, not prose', () => {
    expect(looksLikeDiagramCode('graph TD\n  A --> B')).toBe(true);
    expect(looksLikeDiagramCode('workspace {\n  model {\n    u = person "U"\n  }\n}')).toBe(true);
    expect(looksLikeDiagramCode('x -> y: calls\ny: {\n  shape: cylinder\n}')).toBe(true);
    expect(looksLikeDiagramCode(FLOW)).toBe(true);
    expect(looksLikeDiagramCode('Remember to add the fraud check before launch')).toBe(false);
    expect(looksLikeDiagramCode('flowchart')).toBe(false);
  });
});

describe('a pasted Mermaid diagram', () => {
  it('names its frame from its kind and first node, or its title', async () => {
    const { view, doc } = harness(1);
    await act(async () => { await view.result.current.startFrom('graph TD\n  A[Start here] --> B[End]', { openPanel: false }); });
    const frame = doc().pages[0]!.nodes.find((node) => node.kind === 'frame')!;
    expect(frame.content.label).toBe('Flowchart: Start here');
  });
});
