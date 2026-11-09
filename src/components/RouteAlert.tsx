import { memo, useCallback, useState } from 'react';
import type { RouteStats } from '../sim/types';
import { ROUTE_ALERT_START, stepRouteAlert } from './routeHealth';
import './RouteAlert.css';

interface RouteAlertProps {
  routes: readonly RouteStats[];
  /** Client id to the label on its card. */
  nodeNames: Readonly<Record<string, string>>;
}

/**
 * One line at the top of the canvas when one kind of user is failing and
 * another is not. See routeHealth.ts for when it shows; the rest of the
 * time it renders nothing at all.
 *
 * It holds still: it shows once the difference has lasted, goes once it
 * has been gone a while, and refreshes its figures every couple of
 * seconds. A screen reader hears it when it appears and when the routes it
 * names change, not at every new percentage.
 */
export const RouteAlert = memo(function RouteAlert({
  routes,
  nodeNames,
}: RouteAlertProps) {
  const nameOf = useCallback((id: string) => nodeNames[id] || 'Client', [nodeNames]);
  // Stepped once per new reading, during render, so the line on screen is
  // never a frame behind the routes it describes.
  const [seen, setSeen] = useState({ routes, state: ROUTE_ALERT_START });
  let state = seen.state;
  if (seen.routes !== routes) {
    const last = routes[0]?.history;
    const nowMs = last && last.length > 0 ? last[last.length - 1].t : 0;
    state = stepRouteAlert(seen.state, routes, nowMs, nameOf);
    setSeen({ routes, state });
  }
  const text = state.shown?.text ?? null;
  return (
    <div className="route-alert-wrap" data-chrome="route-alert">
      <p className="sr-only" role="status">
        {state.spoken}
      </p>
      {text ? (
        <p className="route-alert" aria-hidden="true">
          <span className="route-alert-dot" />
          <span className="route-alert-text">{text}</span>
        </p>
      ) : null}
    </div>
  );
});
