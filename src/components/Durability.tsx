import { useId } from 'react';
import { formatDownFor } from './faultWiring';

/* ------------------------------------------------------------------ *
 * Durability: whether a store's writes are on disk when it says they are
 * saved, and what a crash or restart then loses. The setting is a design
 * edit; the inspector's counts beside it are the engine's own.
 * ------------------------------------------------------------------ */

/** The choices for "Writes reach disk", in ms after the write. 0 is before it answers. */
const FLUSH_CHOICES: readonly number[] = [0, 10, 100, 1000];

function choiceLabel(ms: number): string {
  return ms === 0
    ? 'Before it answers'
    : `Within ${ms < 1000 ? `${ms}ms` : formatDownFor(ms)}`;
}

/**
 * The "Writes reach disk" setting. 0 removes the field, so a design that
 * never changed it saves and shares exactly as before.
 */
export function FlushRow({
  value,
  locked,
  onChange,
}: {
  /** `flushEveryMs`, 0 when unset. */
  value: number;
  /** Held still by a challenge. */
  locked?: string;
  onChange: (flushEveryMs: number | undefined) => void;
}) {
  const id = useId();
  const hintId = useId();
  // A value set elsewhere, by a file or a model, is shown as itself.
  const choices = FLUSH_CHOICES.includes(value)
    ? FLUSH_CHOICES
    : [...FLUSH_CHOICES, value];
  return (
    <div className={locked ? 'ins-field-row is-locked' : 'ins-field-row'}>
      <label className="row-k" htmlFor={id}>
        Writes reach disk
      </label>
      <select
        id={id}
        className="ins-number is-phrase"
        value={value}
        disabled={locked !== undefined}
        aria-describedby={hintId}
        onChange={(e) => {
          const ms = Number(e.currentTarget.value);
          onChange(ms > 0 ? ms : undefined);
        }}
      >
        {choices.map((ms) => (
          <option key={ms} value={ms}>
            {choiceLabel(ms)}
          </option>
        ))}
      </select>
      <p id={hintId} className="ins-hint">
        {locked ??
          (value > 0
            ? `It answers before the write is on disk, and writes it there ${choiceLabel(value).toLowerCase()}. A crash or restart loses every write still waiting.`
            : 'It writes each change to disk before it answers, so a crash loses nothing it said was saved.')}
      </p>
    </div>
  );
}
