import { describe, expect, it } from 'vitest';
import { EMPTY_BOOT_PARAMS, parseBootParams } from './urlParams';

describe('parseBootParams', () => {
  it('is all-empty for a plain URL', () => {
    expect(parseBootParams('', '')).toEqual(EMPTY_BOOT_PARAMS);
  });

  it('accepts a known preset id', () => {
    expect(parseBootParams('?preset=load-balanced', '').presetId).toBe('load-balanced');
    expect(parseBootParams('?preset=single-server', '').presetId).toBe('single-server');
  });

  it('rejects an unknown preset id, booting the stored session instead', () => {
    expect(parseBootParams('?preset=not-a-preset', '').presetId).toBeNull();
    expect(parseBootParams('?preset=<script>', '').presetId).toBeNull();
  });

  it('accepts theme from the query', () => {
    expect(parseBootParams('?theme=dark', '').theme).toBe('dark');
    expect(parseBootParams('?theme=system', '').theme).toBe('system');
  });

  it('accepts theme from the hash, and lets the query win when both are present', () => {
    expect(parseBootParams('', '#theme=dark').theme).toBe('dark');
    expect(parseBootParams('?theme=light', '#theme=dark').theme).toBe('light');
  });

  it('rejects a theme that is not one of the three choices', () => {
    expect(parseBootParams('?theme=sepia', '').theme).toBeNull();
  });

  it('does not mistake a share hash for parameters', () => {
    expect(parseBootParams('', '#d1.some-share-payload')).toEqual(EMPTY_BOOT_PARAMS);
  });

  it('parses paused', () => {
    expect(parseBootParams('?paused=1', '').paused).toBe(true);
    expect(parseBootParams('?paused=true', '').paused).toBe(true);
    expect(parseBootParams('?paused=0', '').paused).toBe(false);
    expect(parseBootParams('?paused=yes', '').paused).toBe(false);
  });

  it('clamps warmup to a sane ceiling and ignores garbage', () => {
    expect(parseBootParams('?warmup=3000', '').warmupMs).toBe(3000);
    expect(parseBootParams('?warmup=999999', '').warmupMs).toBe(60_000);
    expect(parseBootParams('?warmup=banana', '').warmupMs).toBe(0);
    expect(parseBootParams('?warmup=-5', '').warmupMs).toBe(0);
  });

  it('parses everything at once', () => {
    expect(
      parseBootParams('?preset=load-balanced&theme=dark&paused=1&warmup=3000', ''),
    ).toEqual({
      presetId: 'load-balanced',
      theme: 'dark',
      paused: true,
      warmupMs: 3000,
    });
  });
});
