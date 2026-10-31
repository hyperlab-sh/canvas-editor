import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useV2EditorNotices } from './useV2EditorNotices';

const runV1Import = vi.hoisted(() => vi.fn());
vi.mock('@/services/storage/v2/v1Import', () => ({ runV1Import }));

const wrapper = ({ children }: { children: React.ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

describe('v1 import notice', () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); });

  // The v1 service-worker kill-switch reloads the tab seconds after the first visit.
  it('shows again after a reload, until it has been seen', async () => {
    const { useV2EditorNotices: first } = await import('./useV2EditorNotices');
    runV1Import.mockResolvedValue({ imported: ['a', 'b'], failures: [], firstRun: true });
    const push = vi.fn();
    renderHook(() => first(push), { wrapper });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: 'Brought over 2 diagrams from the previous editor' })));

    // The reload: a fresh module (nothing shown yet) and an import that finds nothing new.
    vi.resetModules();
    const { useV2EditorNotices: second } = await import('./useV2EditorNotices');
    runV1Import.mockResolvedValue({ imported: [], failures: [], firstRun: false });
    const again = vi.fn();
    renderHook(() => second(again), { wrapper });
    expect(again).toHaveBeenCalledWith(expect.objectContaining({ title: 'Brought over 2 diagrams from the previous editor' }));

    // Clicking through marks it seen.
    again.mock.calls[0]![0].action.onClick();
    expect(localStorage.getItem('ofk.v1ImportNotice')).toBeNull();
  });

  it('stays quiet when nothing came over', async () => {
    runV1Import.mockResolvedValue({ imported: [], failures: [], firstRun: false });
    const push = vi.fn();
    renderHook(() => useV2EditorNotices(push), { wrapper });
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
  });
});
