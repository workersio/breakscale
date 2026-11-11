import { createHttpApp } from './app';
import { HOSTED_BREAK } from './breakIt';

/*
 * The hosted server at mcp.breakscale.tech, as a Vercel function.
 * `api/mcp.js` re-exports this bundle; an Express app is a plain
 * (req, res) handler, which is what the Node runtime calls.
 *
 * No host check: DNS rebinding protection keeps a web page from reaching
 * a server on someone's own machine, and this one is public on purpose.
 *
 * The simulation budget is tighter than the local default. Anyone can
 * call this, and a design sized to run for the full budget on every call
 * is the cheapest way to spend the project's function time. break_it is
 * held to a smaller search for the same reason.
 */
const budgetMs = Number.parseInt(process.env.SIM_BUDGET_MS ?? '1000', 10);

export default createHttpApp({ host: '0.0.0.0', budgetMs, breakLimits: HOSTED_BREAK });
