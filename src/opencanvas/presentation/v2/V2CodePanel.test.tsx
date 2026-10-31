import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { V2CodePanel } from './V2CodePanel';

const panel = (code: string, onCodeChange = vi.fn(), diagnostics: Parameters<typeof V2CodePanel>[0]['diagnostics'] = []) => render(
  <V2CodePanel code={code} diagnostics={diagnostics} generating={false} canvasEdited={false} palette="pastel"
    onPaletteChange={vi.fn()} onCodeChange={onCodeChange} onGenerate={vi.fn()} onClose={vi.fn()} />,
);

describe('V2CodePanel', () => {
  it('highlights exactly the text the editor holds: CRLF, tabs, emoji and combining marks', () => {
    const code = 'flowchart\r\nCafé 🚀 -> "Ship\tit"\r\nB [diamond]';
    const { container } = panel(code);
    const editor = screen.getByRole('textbox', { name: 'Diagram source' }) as HTMLTextAreaElement;
    expect(container.querySelector('.ofk-v2-code-highlight')!.textContent!.replace(/\n$/, '')).toBe(editor.value.replace(/\r\n/g, '\n'));
  });

  it('jumps to a diagnostic on its own line when the source has CRLF', () => {
    panel('flowchart\r\nA -> B\r\nBroken [oops', vi.fn(), [{ code: 'W101', severity: 'warning', line: 3, col: 8, endCol: 13, message: 'bad', source: 'parse' }]);
    const editor = screen.getByRole('textbox', { name: 'Diagram source' }) as HTMLTextAreaElement;
    fireEvent.click(screen.getByText('Line 3'));
    expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe('[oops');
  });

  it('leaves Enter to the input method while it is composing', () => {
    const onCodeChange = vi.fn();
    panel('flowchart\nA', onCodeChange);
    const editor = screen.getByRole('textbox', { name: 'Diagram source' });
    fireEvent.keyDown(editor, { key: ' ', ctrlKey: true });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });
    expect(onCodeChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('is no keyboard trap: Esc leaves the editor for Close, Tab indents, Shift+Tab moves on (WCAG 2.1.2)', () => {
    const onClose = vi.fn();
    const onCodeChange = vi.fn();
    render(<V2CodePanel code="flowchart" diagnostics={[]} generating={false} canvasEdited={false} palette="pastel"
      onPaletteChange={vi.fn()} onCodeChange={onCodeChange} onGenerate={vi.fn()} onClose={onClose} />);
    const editor = screen.getByRole('textbox', { name: 'Diagram source' });
    expect(editor).toHaveAccessibleDescription(/Esc leaves the editor/);
    (editor as HTMLTextAreaElement).setSelectionRange(0, 0);
    fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true });
    expect(onCodeChange).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(onCodeChange).toHaveBeenCalledWith('  flowchart');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Close panel' })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close panel' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens ready to paste over: the source is focused and selected; a template opening leaves focus alone (U1-02)', () => {
    const { unmount } = render(<V2CodePanel code={'flowchart\nA -> B'} diagnostics={[]} generating={false} canvasEdited={false} palette="pastel" selectAll
      onPaletteChange={vi.fn()} onCodeChange={vi.fn()} onGenerate={vi.fn()} onClose={vi.fn()} />);
    const editor = screen.getByRole('textbox', { name: 'Diagram source' }) as HTMLTextAreaElement;
    expect(editor).toHaveFocus();
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([0, editor.value.length]);
    unmount();
    render(<V2CodePanel code="flowchart" diagnostics={[]} generating={false} canvasEdited={false} palette="pastel" autoFocus={false}
      onPaletteChange={vi.fn()} onCodeChange={vi.fn()} onGenerate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Diagram source' })).not.toHaveFocus();
  });

  it('⌘↵ generates from anywhere in the panel, once', () => {
    const onGenerate = vi.fn();
    render(<V2CodePanel code="flowchart" diagnostics={[]} generating={false} canvasEdited={false} palette="pastel"
      onPaletteChange={vi.fn()} onCodeChange={vi.fn()} onGenerate={onGenerate} onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Diagram source' }), { key: 'Enter', metaKey: true });
    expect(onGenerate).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close panel' }), { key: 'Enter', ctrlKey: true });
    expect(onGenerate).toHaveBeenCalledTimes(2);
  });

  // The workspace drops OpenFlowKit's parse diagnostics for foreign text (U1-07, U2-12); what reaches the panel then
  // is the conversion's own report, and a failed Convert must say why (e2e mermaid-import: reserved family).
  it('foreign syntax keeps the banner and still shows a conversion error', () => {
    const diagnostics = [{ code: 'E003' as const, severity: 'error' as const, line: 1, col: 1, endCol: 1, message: 'journey diagrams are not supported yet', source: 'parse' as const }];
    render(<V2CodePanel code={'journey\n  title My day'} diagnostics={diagnostics} generating={false} canvasEdited={false} palette="pastel"
      convertFrom={{ label: 'Mermaid', convert: vi.fn() }}
      onPaletteChange={vi.fn()} onCodeChange={vi.fn()} onGenerate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/Mermaid detected/).textContent).toMatch(/Generate converts it/);
    expect(screen.getByText('journey diagrams are not supported yet')).toBeInTheDocument();
  });

  // Review 2026-10-11: ⌥C on an existing diagram selected its whole source, so the first keystroke wiped it.
  it('an existing diagram source opens with the caret at the end, nothing selected', () => {
    panel('flowchart\nA -> B');
    const editor = screen.getByRole('textbox', { name: 'Diagram source' }) as HTMLTextAreaElement;
    expect(editor).toHaveFocus();
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([editor.value.length, editor.value.length]);
  });

  it('⌘↵ that accepts a suggestion does not also generate', () => {
    const onGenerate = vi.fn();
    render(<V2CodePanel code="flowchart\nA" diagnostics={[]} generating={false} canvasEdited={false} palette="pastel"
      onPaletteChange={vi.fn()} onCodeChange={vi.fn()} onGenerate={onGenerate} onClose={vi.fn()} />);
    const editor = screen.getByRole('textbox', { name: 'Diagram source' });
    fireEvent.keyDown(editor, { key: ' ', ctrlKey: true });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
    expect(onGenerate).not.toHaveBeenCalled();
  });
});
