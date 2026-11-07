import { describe, expect, it } from 'vitest';
import { formatGoalMs, formatGoalPct, formatShareDown } from './format';

/**
 * A reading set beside a "no more than" goal rounds toward failing it, so a
 * miss can never print as on the line. The cases are the ones nearest-rank
 * rounding got wrong: just over a goal, exactly on it, and the float noise
 * that would push a value on the line past it.
 */

describe('against a goal', () => {
  it('prints a latency just over the goal as over it', () => {
    expect(formatGoalMs(200.4)).toBe('201ms');
    expect(formatGoalMs(200)).toBe('200ms');
    expect(formatGoalMs(199.2)).toBe('200ms');
    expect(formatGoalMs(1000.4)).toBe('1.1s');
    expect(formatGoalMs(1000)).toBe('1s');
    expect(formatGoalMs(4.01)).toBe('4.1ms');
    expect(formatGoalMs(0)).toBe('0ms');
    expect(formatGoalMs(null)).toBe('n/a');
  });

  it('prints a loss just over the goal as over it', () => {
    expect(formatGoalPct(1.004)).toBe('1.1%');
    expect(formatGoalPct(1)).toBe('1%');
    expect(formatGoalPct(0.9)).toBe('0.9%');
    expect(formatGoalPct(0.901)).toBe('0.91%');
    expect(formatGoalPct(0.031)).toBe('0.04%');
    // Never zero for a loss that happened.
    expect(formatGoalPct(0.0001)).toBe('0.01%');
    expect(formatGoalPct(0)).toBe('0%');
    expect(formatGoalPct(30.07)).toBe('31%');
  });

  it('prints a share short of its floor as short of it', () => {
    expect(formatShareDown(0.9799)).toBe('97.9%');
    expect(formatShareDown(0.98)).toBe('98%');
    expect(formatShareDown(1)).toBe('100%');
    expect(formatShareDown(0.931)).toBe('93.1%');
  });
});
