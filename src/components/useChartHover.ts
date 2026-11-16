import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { aimedIndex, steppedIndex, type HoverAim } from './chartReadout';

/**
 * The readout under a chart: point at the plot, or press and drag on a
 * touch screen, and the legend reads the sample there instead of the live
 * figure. Focus the plot and the arrow keys step through the samples.
 *
 * Only measured samples are ever read out. Nothing between two samples is
 * interpolated: the readout snaps to the nearest one.
 */
export interface ChartHover {
  /** The sample being read, or -1 while the legend shows live figures. */
  index: number;
  /** Props for the plot box. */
  plotProps: {
    tabIndex: 0;
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: () => void;
    onPointerLeave: (e: PointerEvent<HTMLDivElement>) => void;
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
    onBlur: () => void;
  };
  /** True while the keys are reading, when the readout is announced. */
  keyed: boolean;
}

/** A pointer's x across the plot box, in px from its left edge. */
const pxOf = (e: PointerEvent<HTMLDivElement>) =>
  e.clientX - e.currentTarget.getBoundingClientRect().left;

export function useChartHover<T extends { t: number }>(
  samples: readonly T[],
  xPx: (t: number) => number,
  plotRef: RefObject<HTMLDivElement | null>,
): ChartHover {
  const [aim, setAim] = useState<HoverAim | null>(null);
  const [touching, setTouching] = useState(false);
  const index = aimedIndex(samples, aim, xPx);

  /* A lifted finger leaves the readout on its sample, so it can be read
     without a thumb over it. A tap anywhere else puts the live figures
     back. The document is outside React, which is why this is an effect. */
  const pinnedByTouch = aim?.kind === 'sample' && aim.by === 'touch';
  useEffect(() => {
    if (!pinnedByTouch) return;
    const onDown = (e: Event) => {
      const plot = plotRef.current;
      if (plot && e.target instanceof Node && plot.contains(e.target)) return;
      setAim(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [pinnedByTouch, plotRef]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'touch') return;
    setTouching(true);
    setAim({ kind: 'pointer', px: pxOf(e) });
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      // A finger only reads while it is down; between touches it is not there.
      if (e.pointerType === 'touch' && !touching) return;
      setAim({ kind: 'pointer', px: pxOf(e) });
    },
    [touching],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== 'touch') return;
      setTouching(false);
      const at = aimedIndex(samples, { kind: 'pointer', px: pxOf(e) }, xPx);
      setAim(at >= 0 ? { kind: 'sample', t: samples[at]!.t, by: 'touch' } : null);
    },
    [samples, xPx],
  );

  // The browser took the touch for a scroll of the strip (touch-action:
  // pan-y), so it was never meant as a reading.
  const onPointerCancel = useCallback(() => {
    setTouching(false);
    setAim(null);
  }, []);

  const onPointerLeave = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    setAim((a) => (a?.kind === 'pointer' ? null : a));
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        if (aim === null) return;
        e.stopPropagation();
        setAim(null);
        return;
      }
      const next = steppedIndex(e.key, index, samples.length);
      if (next === null) return;
      e.preventDefault();
      setAim({ kind: 'sample', t: samples[next]!.t, by: 'key' });
    },
    [aim, index, samples],
  );

  const onBlur = useCallback(() => {
    setAim((a) => (a?.kind === 'sample' && a.by === 'key' ? null : a));
  }, []);

  const plotProps = useMemo(
    () => ({
      tabIndex: 0 as const,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerLeave,
      onKeyDown,
      onBlur,
    }),
    [
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerLeave,
      onKeyDown,
      onBlur,
    ],
  );

  return {
    index,
    plotProps,
    keyed: aim?.kind === 'sample' && aim.by === 'key' && index >= 0,
  };
}
