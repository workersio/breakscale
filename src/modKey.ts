/**
 * Shortcut labels in the reader's own keys. Every Ctrl chord in the app also
 * answers to Cmd, so a Mac shows ⌘ where everyone else sees Ctrl.
 */

interface NavigatorWithData extends Navigator {
  userAgentData?: { platform?: string };
}

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as NavigatorWithData;
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * "Ctrl+Shift+Z" as the reader would press it: unchanged off a Mac, "⇧⌘Z" on
 * one. Only a leading Ctrl is swapped, so "Ctrl+wheel", which really is the
 * Control key on every machine, is left alone by callers that skip it.
 */
export function shortcutLabel(keys: string, mac: boolean = isMac()): string {
  if (!mac || !keys.startsWith('Ctrl')) return keys;
  const rest = keys.slice('Ctrl'.length);
  if (rest.startsWith('+Shift+')) return `⇧⌘${rest.slice('+Shift+'.length)}`;
  if (rest.startsWith('+')) return `⌘${rest.slice(1)}`;
  return `⌘${rest}`;
}
