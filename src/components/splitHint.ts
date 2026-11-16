/**
 * A hint's first sentence, and whatever follows it.
 *
 * A field gets one short line under it. Anything longer waits behind the
 * small info mark, so a panel of twelve fields does not read as a page of
 * prose and the line a student needs first is the one they see.
 */
export function splitHint(text: string): readonly [string, string] {
  const m = /^(.+?[.!?])\s+(\S.*)$/s.exec(text);
  return m ? [m[1] ?? text, m[2] ?? ''] : [text, ''];
}
