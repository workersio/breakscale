/**
 * When the shell uses its phone layout: a header, a tab bar and sheets.
 *
 * A width alone missed a phone on its side. At 844x390 it is wider than 720,
 * so it got the desktop's floating panels, and with one part selected the
 * canvas left between them was 276px wide. What a phone on its side lacks is
 * height, and what tells it from a short desktop window is a finger, so the
 * second half of the query is both. Every stylesheet rule for the phone
 * layout states the same pair; see `phoneSheets.test.ts`.
 */
export const PHONE_QUERY =
  '(max-width: 720px), (pointer: coarse) and (max-height: 500px)';

/**
 * The sideways half of it, where App.css puts the header on one row and the
 * sheets at the sides, because 390px of height cannot hold a sheet above a
 * diagram.
 */
export const PHONE_LANDSCAPE_QUERY = '(pointer: coarse) and (max-height: 500px)';
