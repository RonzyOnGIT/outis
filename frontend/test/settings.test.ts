import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_DEFAULT_NEVER_HIDE, loadSettings } from '../lib/settings';

afterEach(() => vi.unstubAllGlobals());
function stored(settings: object | undefined) {
  vi.stubGlobal('browser', { storage: { local: { get: async () => ({ settings }) } } });
}

describe('context-aware settings upgrade', () => {
  it('lets the context engine handle public products on a fresh install', async () => {
    stored(undefined);
    expect((await loadSettings()).neverHide).toEqual([]);
  });
  it('migrates only the complete stock list, even if reordered', async () => {
    stored({ neverHide: [...LEGACY_DEFAULT_NEVER_HIDE].reverse() });
    expect((await loadSettings()).neverHide).toEqual([]);
  });
  it.each([{ entries: ['Google'] }, { entries: [...LEGACY_DEFAULT_NEVER_HIDE, 'Acme'] }, { entries: [] }])('preserves a customized Never hide list: $entries', async ({ entries }) => {
    stored({ neverHide: entries });
    expect((await loadSettings()).neverHide).toEqual(entries);
  });
});
