import { createElement, useCallback, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import type { NodeKind } from '../sim/types';
import {
  ICON_BOX,
  ICON_STROKE,
  KIND_GROUPS,
  KIND_ICON,
  KIND_NAME,
  KIND_TERM,
  NODE_DND_MIME,
  whatIsKind,
} from './nodeVisuals';
import type { KindGroup } from './nodeVisuals';
import { Term } from './Tooltip';
import { usePreference } from '../content/preferences';
import { useVendor } from '../content/vendors/useVendor';
import { nameFor } from '../content/vendors/lookup';
import type { Vendor } from '../content/vendors/types';
import { ANN_DND_MIME } from './annotationLayout';
import { rovingIndex } from './roving';
import './Palette.css';

/* ------------------------------------------------------------------ *
 * Structure
 *
 * Fourteen kinds and thirteen presets in a 224px rail is 27 rows. Listed
 * flat that is a 1100px column: a wall of text that must be scrolled to
 * be read, which means the student cannot see what the app offers.
 *
 * The fix is GROUPING, not shrinking. The groups themselves are
 * KIND_GROUPS in nodeVisuals.ts, shared with the canvas ledger; what the
 * rail adds is the rendering.
 *
 * Sections collapse, and the open/closed state is local UI state that
 * the shell does not need to know about. Components stay open by
 * default because that is the rail's primary job; Examples too, since
 * that is how a student starts. Keys is closed — it is a reference, not
 * a task.
 * ------------------------------------------------------------------ */

/**
 * Shown as the row's `title` only. The prose that used to render under
 * every name is what made this rail 260px wide with 84px rows; the real
 * explanation lives in the inspector, where there is room for it and
 * where the student is already looking once they have chosen.
 */
const KIND_HINT: Record<NodeKind, string> = {
  client: 'Sends requests at the rate you set',
  lb: 'Spreads requests across several servers',
  service: 'Handles a request, calls what it needs',
  cache: 'Answers repeat reads without the database',
  db: 'Stores the data. Usually saturates first',
  queue: 'Holds work so the sender does not wait',
  worker: 'Drains the queue in the background',
  replica: 'Scales reads, but they can be stale',
  shard: 'Splits data by key. A hot key ruins it',
  autoscaler: 'Adds capacity when load rises, after a delay',
  region: 'Fails traffic over to another region',
  cdn: 'Serves most requests before they reach you',
  ratelimiter: 'Refuses excess traffic cheaply, at the door',
  breaker: 'Stops calling a dependency that is failing',
  objectstore: 'Blobs: slow per request, near-unlimited',
  searchindex: 'Fast search, but writes index late',
  timeseriesdb: 'Swallows metrics; range queries cost',
  graphdb: 'Relationships. Depth multiplies the cost',
  coldstorage: 'Archive tier: cheap, and takes seconds',
  vectordb: 'Similarity search. Recall costs latency',
  streambroker: 'A replayable log; consumers fall behind',
  pubsub: 'One publish becomes N deliveries',
  websocket: 'Holds connections; they run out, not rps',
  apigateway: 'Auth, rate limits and routing at the door',
  sidecar: 'A proxy tax on every hop, buying retries',
  lambda: 'Scales instantly, but cold starts cost',
  cron: 'Dumps a burst of work on a schedule',
  bulkhead: 'Caps calls to one dependency; contains it',
  retryqueue: 'Redelivers failures; dead-letters the rest',
  transcoder: 'Grinds long CPU jobs pulled off a queue',
  edgecompute: 'Answers what it can at the edge itself',
  writebehind: 'Acks writes fast; a crash loses the buffer',
  loadshedder: 'Under load, drops low-priority traffic first',
};

/**
 * The same icon primitives the canvas draws, so a row in the palette is
 * visually the exact object that lands on the canvas. A bare stroked icon
 * in currentColor, never an icon inside a filled square. Sized in em so it
 * tracks the row's own type size instead of a hardcoded pixel count.
 */
function Glyph({ kind }: { kind: NodeKind }) {
  return (
    <svg
      width="1.1em"
      height="1.1em"
      viewBox={`0 0 ${ICON_BOX} ${ICON_BOX}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="presentation"
      aria-hidden="true"
    >
      {KIND_ICON[kind].map(([tag, attrs], i) =>
        createElement(tag, { key: i, ...attrs }),
      )}
    </svg>
  );
}

export type AnnotationTool = 'note' | 'section';

/**
 * The two annotation rows. Not components: they carry no traffic, have no
 * simulation behaviour and never reach the engine, so they sit in their own
 * group rather than borrowing a NodeKind. The icons are drawn inline for
 * the same reason: KIND_ICON is the engine-backed vocabulary and these are
 * not in it.
 */
const ANN_ROWS: {
  tool: AnnotationTool;
  name: string;
  hint: string;
  icon: string[];
}[] = [
  {
    tool: 'note',
    name: 'Note',
    hint: 'Click, then click the canvas to place text (N)',
    // Lucide "type": text as text.
    icon: ['M4 7V5h16v2', 'M9 20h6', 'M12 5v15'],
  },
  {
    tool: 'section',
    name: 'Section',
    hint: 'Click, then drag on the canvas to frame a group (B)',
    // A frame with a label notch: the thing it draws.
    icon: [
      'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
      'M3 9h8',
    ],
  },
];

/**
 * Does `kind` match the typed query?
 *
 * Matches the display name, the one-line hint and the group title, so
 * "melting" finds the Control group's contents and "stale" finds read
 * replicas. Searching only the names would fail exactly the student this
 * is for: someone who knows the problem they have but not what the
 * component is called.
 *
 * Substring rather than fuzzy. A 33-item list is small enough that a
 * substring match is predictable, and predictability beats cleverness when
 * the result is "the thing you wanted is not on screen".
 */
function matchesKind(
  kind: NodeKind,
  group: KindGroup,
  needle: string,
  vendor: Vendor | null,
): boolean {
  return (
    KIND_NAME[kind].toLowerCase().includes(needle) ||
    // The vendor name too, so someone who typed "RDS" finds the database
    // even though the concept is what the rail is organised by.
    nameFor(kind, vendor).toLowerCase().includes(needle) ||
    KIND_HINT[kind].toLowerCase().includes(needle) ||
    group.title.toLowerCase().includes(needle)
  );
}

export interface PaletteProps {
  /** Add a node of `kind` to the canvas at a default position. */
  onAdd: (kind: NodeKind) => void;
  /**
   * Arm the note or section tool. The next drag on the canvas draws the
   * shape; clicking the row again disarms.
   */
  onAddAnnotation?: (tool: AnnotationTool) => void;
  /**
   * Which tool is armed, so the row can say so. A control that puts the app
   * into a mode has to show the mode is on, or the changed cursor is the only
   * evidence and the student who looks back at the rail sees nothing.
   */
  armedTool?: AnnotationTool | null;
}

/* ------------------------------------------------------------------ *
 * The pickup.
 *
 * The browser's default drag image is a translucent screenshot of the whole
 * row, list chrome and all, which reads as dragging a menu entry. The thing
 * being carried is a component about to exist on the canvas, so what follows
 * the cursor is a small card instead: the row's own chip and name on the
 * node radius with a lift shadow.
 *
 * A native drag image is sampled ONCE at dragstart and can never animate,
 * so the card is not handed to setDragImage. The native image is replaced
 * with a transparent pixel and the card is a real element that follows the
 * pointer from `dragover` on the document: it pops in when picked up and
 * banks a few degrees with the horizontal velocity of the hand, the way a
 * card carried across a desk would. Cost per move is one translate3d write
 * on a fixed, pointer-events-none element, which is compositor work only;
 * nothing re-renders and nothing lays out.
 * ------------------------------------------------------------------ */

/**
 * Transparent stand-in for the native drag image. Created once and kept hot:
 * setDragImage needs a DECODED image at dragstart, and a data URI this size
 * is decoded long before a human can begin a drag.
 */
const BLANK_DRAG_IMAGE = typeof Image !== 'undefined' ? new Image() : null;
if (BLANK_DRAG_IMAGE) {
  BLANK_DRAG_IMAGE.src =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
}

/**
 * The card, built from the row's rendered DOM rather than re-created in
 * React: the glyph is cloned as-is, the name is read back as text, and the
 * `data-kind` attribute rides along so the chip keeps its colour trio
 * through the same contract every other surface uses.
 */
function buildCard(row: HTMLButtonElement): HTMLDivElement | null {
  const glyph = row.querySelector('.pal-glyph');
  const name = row.querySelector('.pal-name')?.textContent;
  if (!glyph || !name) return null;
  const card = document.createElement('div');
  card.className = 'pal-carry-card';
  const kind = row.getAttribute('data-kind');
  if (kind !== null) card.setAttribute('data-kind', kind);
  card.appendChild(glyph.cloneNode(true));
  const label = document.createElement('span');
  label.className = 'pal-carry-name';
  label.textContent = name;
  card.appendChild(label);
  return card;
}

/* Module state for the one live preview. A drag is a singleton gesture: the
   browser will not start a second before dragend ends the first. */
let carryEl: HTMLDivElement | null = null;
let carryCard: HTMLDivElement | null = null;
let carryX = 0;

function moveCarry(e: globalThis.DragEvent): void {
  if (!carryEl) return;
  carryEl.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
  // Bank with the hand. The inner card owns the rotation and eases it with
  // its own transition, so the outer element can jump to the pointer with no
  // easing at all: position must never lag the cursor, only the tilt may.
  const dx = e.clientX - carryX;
  carryX = e.clientX;
  if (carryCard) {
    const tilt = Math.max(-6, Math.min(6, dx * 0.5));
    carryCard.style.transform = `rotate(${tilt}deg)`;
  }
}

function endCarry(): void {
  document.removeEventListener('dragover', moveCarry);
  carryEl?.remove();
  carryEl = null;
  carryCard = null;
}

/**
 * Fallback when the blank image is somehow not ready: the same card, parked
 * off screen and sampled once by setDragImage. Static, but still a card.
 */
function setStaticCardImage(event: DragEvent<HTMLButtonElement>): void {
  const card = buildCard(event.currentTarget);
  if (!card) return;
  const park = document.createElement('div');
  park.className = 'pal-carry-park';
  park.appendChild(card);
  document.body.appendChild(park);
  const rect = card.getBoundingClientRect();
  event.dataTransfer.setDragImage(card, rect.width / 2, rect.height / 2);
  setTimeout(() => park.remove(), 0);
}

function startCarry(event: DragEvent<HTMLButtonElement>): void {
  const dt = event.dataTransfer;
  if (typeof dt.setDragImage !== 'function') return;
  if (!BLANK_DRAG_IMAGE?.complete) {
    setStaticCardImage(event);
    return;
  }
  const card = buildCard(event.currentTarget);
  if (!card) return;
  endCarry(); // a stale preview from an interrupted drag must not linger
  dt.setDragImage(BLANK_DRAG_IMAGE, 0, 0);

  const outer = document.createElement('div');
  outer.className = 'pal-carry';
  const pop = document.createElement('div');
  pop.className = 'pal-carry-pop';
  pop.appendChild(card);
  outer.appendChild(pop);
  outer.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
  document.body.appendChild(outer);

  carryEl = outer;
  carryCard = card;
  carryX = event.clientX;
  document.addEventListener('dragover', moveCarry);
}

function handleDragStart(event: DragEvent<HTMLButtonElement>, kind: NodeKind) {
  const dt = event.dataTransfer;
  // Must match what Canvas checks for in onDragOver / onDrop.
  dt.setData(NODE_DND_MIME, kind);
  dt.effectAllowed = 'copy';
  startCarry(event);
}

function handleAnnDragStart(event: DragEvent<HTMLButtonElement>, tool: AnnotationTool) {
  const dt = event.dataTransfer;
  dt.setData(ANN_DND_MIME, tool);
  dt.effectAllowed = 'copy';
  startCarry(event);
}

export function Palette({ onAdd, onAddAnnotation, armedTool }: PaletteProps) {
  /**
   * Whether the hover explanations are on. With them OFF (the default) the
   * per-row "?" mark is not rendered at all: <Term> degrades to its bare
   * children then, which left 33 inert question marks with no handler and no
   * focus stop — decoration that could only mislead — and their sr-only
   * labels, no longer anchored by the positioned .pal-explain wrapper,
   * silently extended the document's scroll box by ~634px.
   */
  const hintsOn = usePreference('tooltips');
  const vendor = useVendor();

  const totalKinds = useMemo(
    () => KIND_GROUPS.reduce((n, g) => n + g.kinds.length, 0),
    [],
  );

  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const needle = query.trim().toLowerCase();

  /**
   * The groups with non-matching kinds removed, and empty groups dropped.
   *
   * Filtering rather than reordering keeps the taxonomy intact while
   * searching: a student who typed "cache" and sees it under Data has
   * learned where to find it next time without the search box.
   */
  const groups = useMemo(() => {
    if (!needle) return KIND_GROUPS;
    return KIND_GROUPS.map((g) => ({
      ...g,
      kinds: g.kinds.filter((k) => matchesKind(k, g, needle, vendor)),
    })).filter((g) => g.kinds.length > 0);
  }, [needle, vendor]);

  const matchCount = useMemo(
    () => groups.reduce((n, g) => n + g.kinds.length, 0),
    [groups],
  );

  const onSearchChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  }, []);

  /** Escape clears the box, then gives it up. The usual contract for search. */
  /* The rows are one Tab stop, not 33 (66 with their "?" marks): arrows
     move between them, Enter or Space adds one, "?" explains the focused
     one. `active` is the row Tab returns to. */
  const [active, setActive] = useState<string | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const onRowsKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const item = target.closest('.pal-item');
    const row = item?.querySelector<HTMLButtonElement>('.pal-row');
    if (!row) return;
    if (e.key === '?' && target === row) {
      // The row's own explanation, not the app's glossary.
      const term = item?.querySelector<HTMLElement>('.pal-explain');
      if (!term) return;
      e.preventDefault();
      e.stopPropagation();
      term.focus();
      return;
    }
    if (e.key === 'Escape' && target !== row) {
      row.focus();
      return;
    }
    const rows = [
      ...(e.currentTarget.querySelectorAll<HTMLButtonElement>('.pal-row') ?? []),
    ];
    const next = rovingIndex(e.key, rows.indexOf(row), rows.length);
    if (next === null || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    rows[next]?.focus();
  }, []);

  const onSearchKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      const rows = [
        ...(rowsRef.current?.querySelectorAll<HTMLButtonElement>('.pal-row') ?? []),
      ];
      const to = rows.find((r) => r.tabIndex === 0) ?? rows[0];
      if (!to) return;
      e.preventDefault();
      to.focus();
      return;
    }
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    setQuery((q) => {
      if (q) return '';
      searchRef.current?.blur();
      return q;
    });
  }, []);

  /**
   * Enter and Space both activate a row. A <button> already does this,
   * but the row is also draggable, and Firefox drops the implicit Space
   * activation on a draggable button — so it is restored explicitly
   * rather than left to chance.
   */
  const onRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, kind: NodeKind) => {
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        onAdd(kind);
      }
    },
    [onAdd],
  );

  const rowKeys: string[] = groups.flatMap((g) => g.kinds as string[]);
  if (onAddAnnotation) for (const r of ANN_ROWS) rowKeys.push(r.tool);
  const tabRow = active !== null && rowKeys.includes(active) ? active : rowKeys[0];

  return (
    <nav className="pal" aria-label="Components and examples">
      <div className="pal-scroll scroll">
        {/* Not a disclosure. The rail itself already hides and shows with one
            button and a keyboard shortcut, so wrapping its only remaining
            section in a second collapse gave the same content two ways to
            disappear and made the components one extra click away for no gain.
            A heading and a list is the whole of it now.

            Groups inside are not separately collapsible either: two levels of
            disclosure in a 224px rail is a filing cabinet, not a tool. */}
        <div className="pal-section">
          <p className="label pal-heading">
            Components{' '}
            <span className="pal-heading-count">
              {needle ? `${matchCount} of ${totalKinds}` : totalKinds}
            </span>
          </p>

          {/* Thirty-three rows is more than a person scans, and the rail had
              no way to ask for one by name. A plain text input rather than a
              combobox: it filters a list that stays visible and keeps its
              grouping, so there is no popup, no active-descendant and nothing
              to announce beyond the count, which the live region below does. */}
          <div className="pal-search">
            <svg
              className="pal-search-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.2-3.2" />
            </svg>
            <input
              ref={searchRef}
              type="search"
              className="pal-search-input"
              placeholder="Search"
              aria-label="Search components"
              value={query}
              onChange={onSearchChange}
              onKeyDown={onSearchKeyDown}
            />
            {query && (
              <button
                type="button"
                className="pal-search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* The count is announced, not just shown: a filter that silently
              empties the list leaves a screen reader user with no idea it
              did anything. */}
          <p className="sr-only" role="status">
            {needle
              ? `${matchCount} of ${totalKinds} components match ${query.trim()}`
              : ''}
          </p>

          {needle && matchCount === 0 && (
            <p className="pal-empty">
              Nothing matches {'\u201c'}
              {query.trim()}
              {'\u201d'}. Searching what a component does works too, like {'\u201c'}
              stale{'\u201d'} or {'\u201c'}refuse{'\u201d'}.
            </p>
          )}

          {/* One Tab stop for every row below; see onRowsKeyDown. */}
          <div
            ref={rowsRef}
            className="pal-rows"
            onKeyDown={onRowsKeyDown}
            onFocus={(e) => {
              const key = (e.target as HTMLElement).dataset.row;
              if (key) setActive(key);
            }}
          >
            {groups.map((group) => (
              <div className="pal-group" key={group.id}>
                <p className="label pal-group-title">{group.title}</p>
                <ul className="pal-list">
                  {group.kinds.map((kind) => (
                    /*
                    WHY THE EXPLANATION IS NOT ON THE ROW ITSELF.

                    Every other surface in the app wraps the label in <Term>.
                    Here that is wrong, and the reason is what the row DOES:
                    clicking it puts a component on the canvas. Making the
                    name a tooltip trigger would nest one interactive element
                    inside another, and worse, it would mean the gesture for
                    "what IS a circuit breaker?" and the gesture for "give me
                    a circuit breaker" are the same click. A student browsing
                    to learn would litter the canvas doing it.

                    So the trigger is a SIBLING of the button, not a child.
                    The row keeps its click, its drag and its keyboard
                    activation exactly as they were; the mark beside it
                    explains. Hovering anywhere on the row reveals the mark,
                    so it is discoverable without being 33 permanent dots.
                  */
                    <li key={kind} className="pal-item">
                      <button
                        type="button"
                        className="pal-row"
                        /* Drives the chip's colour trio in Palette.css. This
                         is the same `data-kind` contract the canvas uses,
                         so a kind is coloured by one rule per surface
                         rather than by an inline style computed in JS. */
                        data-kind={kind}
                        data-row={kind}
                        tabIndex={kind === tabRow ? 0 : -1}
                        draggable
                        onDragStart={(e) => handleDragStart(e, kind)}
                        onDragEnd={endCarry}
                        onClick={() => onAdd(kind)}
                        onKeyDown={(e) => onRowKeyDown(e, kind)}
                        title={KIND_HINT[kind]}
                      >
                        <span className="pal-glyph">
                          <Glyph kind={kind} />
                        </span>
                        {/* The generic name stays the heading and the vendor's
                          product goes beneath it. Swapping them outright made
                          two rows read "Amazon EC2" (a service and a worker
                          are both an instance) and truncated the longer
                          names, which is worse than useless in a rail whose
                          job is telling components apart. */}
                        <span className="pal-names">
                          <span className="pal-name">{KIND_NAME[kind]}</span>
                          {vendor && nameFor(kind, vendor) !== KIND_NAME[kind] && (
                            <span className="pal-vendor">{nameFor(kind, vendor)}</span>
                          )}
                        </span>
                      </button>
                      {/*
                      `bare` because the row is already a strong affordance
                      and a dotted underline on a lone question mark would be
                      noise on top of noise. The tooltip itself is unchanged.
                    */}
                      {hintsOn && (
                        <Term
                          id={KIND_TERM[kind]}
                          className="pal-explain"
                          bare
                          tabIndex={-1}
                        >
                          <span aria-hidden="true">?</span>
                          <span className="sr-only">{whatIsKind(kind)}</span>
                        </Term>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {/*
            Annotation rows: the documentation layer. Same affordances as a
            component row (drag onto the canvas, or click to place at the
            centre of the view), so nothing new has to be learned; the
            neutral chip is what says "not a component". The keyboard route
            (N / B arming a tool) is printed in each row's title.
          */}
            {onAddAnnotation && (
              <div className="pal-group">
                <p className="label pal-group-title">Annotate</p>
                <ul className="pal-list">
                  {ANN_ROWS.map((row) => (
                    <li key={row.tool} className="pal-item">
                      <button
                        type="button"
                        className={`pal-row${armedTool === row.tool ? ' is-armed' : ''}`}
                        aria-pressed={armedTool === row.tool}
                        data-row={row.tool}
                        tabIndex={row.tool === tabRow ? 0 : -1}
                        draggable
                        onDragStart={(e) => handleAnnDragStart(e, row.tool)}
                        onDragEnd={endCarry}
                        onClick={() => onAddAnnotation(row.tool)}
                        onKeyDown={(e) => {
                          if (e.key === ' ' || e.key === 'Spacebar') {
                            e.preventDefault();
                            onAddAnnotation(row.tool);
                          }
                        }}
                        title={row.hint}
                      >
                        <span className="pal-glyph">
                          <svg
                            width="1.1em"
                            height="1.1em"
                            viewBox={`0 0 ${ICON_BOX} ${ICON_BOX}`}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={ICON_STROKE}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            role="presentation"
                            aria-hidden="true"
                          >
                            {row.icon.map((d) => (
                              <path key={d} d={d} />
                            ))}
                          </svg>
                        </span>
                        <span className="pal-name">{row.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
