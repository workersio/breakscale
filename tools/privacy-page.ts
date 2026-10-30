/**
 * Render the privacy policy as a static HTML page at build time, beside the
 * glossary and in the same plain style.
 *
 * Static for the same reason the glossary is: a policy has to be readable by
 * anyone who follows the link, including a directory reviewer or a crawler,
 * without the app booting first. Every claim here describes code in this
 * repository (the share store, the analytics in main.tsx, the MCP server), so
 * a change to what any of those send has to change this page too.
 */

import { SITE_ORIGIN as SITE } from './site.ts';

const UPDATED = '27 September 2026';
const ISSUES = 'https://github.com/workersio/breakscale/issues';

export function renderPrivacyPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Privacy | Breakscale</title>
    <meta
      name="description"
      content="What data Breakscale handles across the website, the VS Code extension and the MCP server. No accounts, no cookies, no ads."
    />
    <link rel="canonical" href="${SITE}/privacy" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />

    <style>
      :root {
        color-scheme: light dark;
        --bg: #faf7f3;
        --text: #1e242e;
        --dim: #525862;
        --line: #e8e2da;
        --accent: #325cbd;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #16151a;
          --text: #eceaf2;
          --dim: #a8a5b4;
          --line: #302f38;
          --accent: #6f9bf0;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 2.5rem 1.25rem 4rem;
        background: var(--bg);
        color: var(--text);
        font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, 'Segoe UI',
          Roboto, sans-serif;
      }
      main { max-width: 46rem; margin: 0 auto; }
      h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .5rem; }
      .lede { color: var(--dim); margin: 0 0 2rem; }
      h2 {
        font-size: 1.15rem;
        margin: 2.5rem 0 .75rem;
        padding-bottom: .4rem;
        border-bottom: 1px solid var(--line);
      }
      p, li { margin: 0 0 .75rem; }
      ul { padding-left: 1.25rem; margin: 0 0 .75rem; }
      a { color: var(--accent); }
      code { font-size: .92em; }
      footer { margin-top: 3rem; color: var(--dim); font-size: .95rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Privacy</h1>
      <p class="lede">
        Breakscale has no accounts, sets no cookies, shows no ads and sells
        nothing. This page says what data each part of it handles: the
        website, the VS Code extension, and the MCP server that AI assistants
        connect to. Last updated ${UPDATED}.
      </p>

      <h2>The website</h2>
      <ul>
        <li>
          Designs you build are kept in your browser's local storage, on your
          device. They are not sent anywhere unless you share one.
        </li>
        <li>
          A share link carries the whole design in the part of the address
          after the <code>#</code>, which browsers never send to a server.
        </li>
        <li>
          A short share link stores the design at
          <code>links.breakscale.tech</code>, encrypted in your browser before
          it is sent. The key stays in the <code>#</code> part of the link, so
          the store only ever holds data it cannot read. Short links do not
          expire; to have one removed, open an issue with the part of the
          link before the <code>#</code>.
        </li>
        <li>
          Vercel Web Analytics and Speed Insights count page views and measure
          how fast pages load, without cookies.
        </li>
        <li>
          To show the project's star count, the page asks GitHub's public API
          for it, so GitHub receives that request.
        </li>
      </ul>

      <h2>The VS Code extension</h2>
      <ul>
        <li>
          It runs on your machine, and saved designs live in VS Code's own
          storage. It has no analytics.
        </li>
        <li>
          Like the website, it asks GitHub for the star count, and short share
          links go through <code>links.breakscale.tech</code>, encrypted first.
        </li>
      </ul>

      <h2>The MCP server</h2>
      <ul>
        <li>
          When your assistant calls a Breakscale tool, it sends the design:
          its components, their settings and how they connect. The server
          checks it, simulates it in memory and sends back the result. The
          design is not stored or logged by Breakscale, and it is gone when
          the request finishes.
        </li>
        <li>
          The hosted server at <code>mcp.breakscale.tech</code> runs on Vercel,
          which keeps short-lived request logs, such as the time, path and
          status of each request, to operate the service.
        </li>
        <li>
          If you ask it to open a short share link, it fetches the encrypted
          design from <code>links.breakscale.tech</code> and decrypts it in
          memory with the key in the link you gave it.
        </li>
        <li>
          Run from npm with <code>npx breakscale-mcp</code>, the server works
          entirely on your machine, and nothing leaves it except that same
          short-link fetch.
        </li>
        <li>
          Your conversation with the assistant is handled by the company that
          provides it, under its own privacy policy. Breakscale only receives
          the tool calls.
        </li>
      </ul>

      <h2>Who else is involved</h2>
      <ul>
        <li>Vercel hosts the website and the MCP server, and runs the page analytics.</li>
        <li>Cloudflare runs the short-link store and serves the domain's DNS.</li>
        <li>GitHub hosts the source code and answers the star-count request.</li>
      </ul>
      <p>Nothing is shared for advertising, and no data is sold.</p>

      <h2>How long data is kept</h2>
      <ul>
        <li>Designs in the browser or the extension: on your device until you delete them.</li>
        <li>Short share links: until removed.</li>
        <li>MCP requests: not stored; only the hosting provider's short-lived logs.</li>
      </ul>

      <h2>Contact</h2>
      <p>
        Questions or requests go to
        <a href="${ISSUES}">GitHub Issues</a>. If this policy changes, this
        page changes with it, and the date at the top says when.
      </p>

      <footer>
        <p><a href="/">Back to Breakscale</a></p>
      </footer>
    </main>
  </body>
</html>
`;
}
