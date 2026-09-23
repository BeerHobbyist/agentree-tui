/**
 * Sidebar sizing rules. Kept free of UI so they can be unit-tested.
 */

/** Width the sidebar starts at, and returns to on reset. */
export const DEFAULT_SIDEBAR_WIDTH = 38;
/** Narrowest the sidebar gets — enough for the footer's status row. */
export const MIN_SIDEBAR_WIDTH = 28;
/** Columns always left for the content pane, however wide the sidebar is dragged. */
export const MIN_CONTENT_WIDTH = 30;
/** Columns one `[` / `]` press moves the divider. */
export const SIDEBAR_WIDTH_STEP = 4;

/**
 * Fit a requested sidebar width to the screen: never below the minimum, and
 * never so wide the content pane drops under MIN_CONTENT_WIDTH. On a screen too
 * narrow for both, the sidebar's minimum wins.
 */
export function clampSidebarWidth(width: number, screenWidth: number): number {
  const max = Math.max(MIN_SIDEBAR_WIDTH, screenWidth - MIN_CONTENT_WIDTH);
  return Math.min(Math.max(Math.round(width), MIN_SIDEBAR_WIDTH), max);
}
