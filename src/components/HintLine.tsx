import { useId } from 'react';
import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { splitHint } from './splitHint';

/**
 * One hint line, with the rest of a long hint on hover or focus.
 *
 * `id` names the paragraph, so a control can point aria-describedby at the
 * whole hint, the part behind the info mark included.
 */
export function HintLine({
  text,
  about,
  id: pid,
}: {
  text: ReactNode;
  about: string;
  id?: string;
}) {
  const id = useId();
  if (typeof text !== 'string') {
    return (
      <p id={pid} className="ins-hint">
        {text}
      </p>
    );
  }
  const [first, rest] = splitHint(text);
  if (!rest) {
    return (
      <p id={pid} className="ins-hint">
        {first}
      </p>
    );
  }
  /* The info mark rides on the sentence's last word, so it never wraps onto
     a line of its own. */
  const cut = first.lastIndexOf(' ');
  return (
    <p id={pid} className="ins-hint">
      {first.slice(0, cut + 1)}
      <span className="ins-more">
        {first.slice(cut + 1)}
        {' '}
        <button
          type="button"
          className="ins-more-btn"
          aria-label={`More about ${about}`}
          aria-describedby={id}
        >
          <Info size={14} strokeWidth={2} aria-hidden="true" />
        </button>
        <span id={id} role="tooltip" className="ins-more-pop">
          {rest}
        </span>
      </span>
    </p>
  );
}
