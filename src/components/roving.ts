/**
 * Roving focus for a list that is one Tab stop: which row a key moves to,
 * or null for a key the list does not handle. Stops at the ends rather than
 * wrapping, so holding an arrow lands on the last row and stays there.
 */
export function rovingIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return Math.min(index + 1, count - 1);
    case 'ArrowUp':
      return Math.max(index - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
