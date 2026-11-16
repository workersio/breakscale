import { useLayoutEffect, useRef, useState } from 'react';
import { formatAt } from './chartReadout';

interface HoverMarksProps {
  /** The sample's x in px across the plot box. */
  x: number;
  /** Its run time in ms, written above the rule. */
  t: number;
  /** Top and bottom of the plot area in px. */
  top: number;
  bottom: number;
  /** The plot box's width in px, to keep the time inside it. */
  w: number;
  /** One dot per series that has a reading at this sample. */
  dots: readonly { y: number; className: string }[];
  /** The sample's headline figure, written beside the time. The legend sits
   *  below the strip's fold on desktop, so this is the reading in view. */
  value?: string;
}

/** Room kept between the label and the plot box's edges, in px. */
const EDGE = 2;

/** The rule, the dots and the time for the sample being read. */
export function HoverMarks({ x, t, top, bottom, w, dots, value }: HoverMarksProps) {
  const rx = Math.round(x) + 0.5;
  const label = useRef<SVGTextElement>(null);
  const text = value ? `${formatAt(t)}  ${value}` : formatAt(t);
  // The label's measured width, so a long reading is slid inside the box
  // rather than cut off at its edge. Zero until measured (and in jsdom).
  const [len, setLen] = useState(0);
  useLayoutEffect(() => {
    const el = label.current;
    const next =
      el && typeof el.getComputedTextLength === 'function'
        ? el.getComputedTextLength()
        : 0;
    setLen((cur) => (Math.abs(cur - next) < 0.5 ? cur : next));
  }, [text]);
  // The time sits on whichever side of the rule has room for it.
  const right = x < w / 2;
  const want = right ? rx + 4 : rx - 4 - len;
  const lx = len > 0 ? Math.max(EDGE, Math.min(w - EDGE - len, want)) : want;
  return (
    <svg className="mx-layer mx-hover" aria-hidden="true">
      <line className="mx-hover-rule" x1={rx} y1={top} x2={rx} y2={bottom} />
      {dots.map((d, i) => (
        <circle key={i} className={`mx-dot ${d.className}`} cx={x} cy={d.y} r={3.5} />
      ))}
      <text
        ref={label}
        className="mx-hover-at"
        x={len > 0 ? lx : right ? rx + 4 : rx - 4}
        y={top - 4}
        textAnchor={len > 0 || right ? 'start' : 'end'}
        xmlSpace="preserve"
      >
        {formatAt(t)}
        {value ? <tspan className="mx-hover-val">{`  ${value}`}</tspan> : null}
      </text>
    </svg>
  );
}
