import './EmptyCanvas.css';

export interface EmptyCanvasProps {
  /**
   * The one-click ways out. Absent inside a brief: every one of them would
   * leave it, and a brief that starts empty means build it yourself.
   */
  actions?: {
    onStartSimple: () => void;
    onBrowseExamples: () => void;
    onTryChallenge: () => void;
  };
}

/**
 * What a cleared canvas says, and the first thing a student can press.
 *
 * Rendered by Canvas as a sibling of .cv-surface. The card itself is
 * pointer-transparent and carries [data-chrome], so a drag from the palette
 * or a marquee across it still reaches the surface; only the buttons take
 * the pointer.
 *
 * The phone sentence swaps by CSS at the same 720px the tab bar uses, so the
 * two can never disagree about where the parts are.
 */
export function EmptyCanvas({ actions }: EmptyCanvasProps) {
  return (
    <div className="cv-empty" data-chrome="">
      <p className="cv-empty-lead">Nothing here yet</p>
      <p className="cv-empty-body">
        <span className="cv-empty-wide">
          Drag a client, a service and a database in from the left.
        </span>
        <span className="cv-empty-phone">
          Open Build to add a client, a service and a database.
        </span>
      </p>
      {actions && (
        <div className="cv-empty-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={actions.onStartSimple}
          >
            Start with one server
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={actions.onBrowseExamples}
          >
            Browse examples
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={actions.onTryChallenge}
          >
            Try a challenge
          </button>
        </div>
      )}
    </div>
  );
}
