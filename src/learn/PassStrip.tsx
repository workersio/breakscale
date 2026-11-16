import './PassStrip.css';

/* ==========================================================================
   A pass, said over the phone's inspector sheet.

   On a phone the brief is a sheet under the inspector's, so a pass that
   lands while a component's settings are up has nowhere to show. This
   strip sits in the task card's slot above the tab bar and says it, and its
   one button puts the settings away so the brief, opened by the pass, shows
   what was learned and the way on.

   Not a live region: the brief's own status line, mounted under the sheet
   the whole time, already says the pass out loud. A second one would say
   it twice.
   ========================================================================== */

export interface PassStripProps {
  /** The brief's name, as its panel heads it. */
  name: string;
  onShow: () => void;
}

export function PassStrip({ name, onShow }: PassStripProps) {
  return (
    <div className="task" data-chrome="pass">
      <div className="card-float pass-strip">
        <p className="pass-strip-text">You passed {name}.</p>
        <button type="button" className="btn btn-sm btn-primary" onClick={onShow}>
          See what you learned
        </button>
      </div>
    </div>
  );
}
