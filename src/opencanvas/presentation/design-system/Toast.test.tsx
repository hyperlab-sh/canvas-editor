import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastRegion, TOAST_LIMIT, withToast, type ToastItem } from './Toast';
import { foundation } from './tokens';

const DURATION = foundation.motion.toastDuration;

describe('withToast', () => {
  it('keeps at most three, newest last', () => {
    let list: ToastItem[] = [];
    for (const id of ['a', 'b', 'c', 'd']) list = withToast(list, { id, title: `Toast ${id}` });
    expect(TOAST_LIMIT).toBe(3);
    expect(list.map((item) => item.id)).toEqual(['b', 'c', 'd']);
  });

  it('collapses a twin of the same title into the newest slot, keeping its id (no second card, no re-entrance)', () => {
    const list = withToast(withToast([{ id: 'one', title: 'Link copied' }], { id: 'two', title: 'Saved' }),
      { id: 'three', title: 'Link copied', tone: 'success' });
    expect(list).toEqual([{ id: 'two', title: 'Saved' }, { id: 'one', title: 'Link copied', tone: 'success' }]);
  });

  it('never drops an action: two same-titled toasts with Undo both stay (still capped, oldest first out)', () => {
    const undo = (id: string) => ({ id, title: '“Untitled” archived', action: { label: 'Undo', onClick: () => undefined } });
    expect(withToast([undo('a')], undo('b')).map((item) => item.id)).toEqual(['a', 'b']);
    expect(withToast([{ id: 'x', title: '“Untitled” archived' }], undo('b')).map((item) => item.id)).toEqual(['x', 'b']);
    expect([undo('a'), undo('b'), undo('c'), undo('d')].reduce<ToastItem[]>(withToast, []).map((item) => item.id)).toEqual(['b', 'c', 'd']);
  });

  it('a re-push with the same id replaces it, action or not', () => {
    expect(withToast([{ id: 'v1', title: 'Old', action: { label: 'Show', onClick: () => undefined } }], { id: 'v1', title: 'New' }))
      .toEqual([{ id: 'v1', title: 'New' }]);
  });

  it('a re-push with the same id replaces it', () => {
    expect(withToast([{ id: 'v1', title: 'Old' }], { id: 'v1', title: 'New' })).toEqual([{ id: 'v1', title: 'New' }]);
  });
});

describe('ToastRegion', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('auto-dismisses an informational toast, but not an error', () => {
    const onDismiss = vi.fn();
    render(<ToastRegion items={[{ id: 'ok', tone: 'success', title: 'Saved' }, { id: 'bad', tone: 'danger', title: 'Export failed' }]} onDismiss={onDismiss} />);
    act(() => { vi.advanceTimersByTime(DURATION * 3); });
    expect(onDismiss.mock.calls).toEqual([['ok']]);
  });

  it('hover pauses the timer and leaving resumes it with the time that was left', () => {
    const onDismiss = vi.fn();
    render(<ToastRegion items={[{ id: 'ok', title: 'Saved' }]} onDismiss={onDismiss} />);
    const toast = screen.getByText('Saved').closest('.ofk-toast')!;
    act(() => { vi.advanceTimersByTime(DURATION - 1000); });
    fireEvent.pointerEnter(toast);
    act(() => { vi.advanceTimersByTime(DURATION * 2); });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerLeave(toast);
    act(() => { vi.advanceTimersByTime(900); });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onDismiss).toHaveBeenCalledWith('ok');
  });

  it('focus inside (Tab to its action) pauses the timer too', () => {
    const onDismiss = vi.fn();
    render(<ToastRegion items={[{ id: 'ok', title: 'Archived', action: { label: 'Undo', onClick: () => undefined } }]} onDismiss={onDismiss} />);
    act(() => { screen.getByRole('button', { name: 'Undo' }).focus(); });
    act(() => { vi.advanceTimersByTime(DURATION * 2); });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => { screen.getByRole('button', { name: 'Undo' }).blur(); });
    act(() => { vi.advanceTimersByTime(DURATION); });
    expect(onDismiss).toHaveBeenCalledWith('ok');
  });

  it('a twin pushed again starts its timer over', () => {
    const onDismiss = vi.fn();
    const first: ToastItem = { id: 'c', title: 'Link copied' };
    const { rerender } = render(<ToastRegion items={[first]} onDismiss={onDismiss} />);
    act(() => { vi.advanceTimersByTime(DURATION - 500); });
    rerender(<ToastRegion items={withToast([first], { id: 'c2', title: 'Link copied' })} onDismiss={onDismiss} />);
    act(() => { vi.advanceTimersByTime(DURATION - 500); });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getAllByText('Link copied')).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(600); });
    expect(onDismiss).toHaveBeenCalledWith('c');
  });

  it('marks a tone with its icon and leaves a neutral toast bare', () => {
    const { container } = render(<ToastRegion items={[{ id: 'i', tone: 'info', title: 'Read-only' }, { id: 'n', title: 'Archived' }]} onDismiss={() => undefined} />);
    const [info, neutral] = [...container.querySelectorAll('.ofk-toast')];
    expect(info!.querySelector('.ofk-toast-mark svg')).not.toBeNull();
    expect(neutral!.querySelector('.ofk-toast-mark')).toBeNull();
  });
});
