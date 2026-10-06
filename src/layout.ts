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

/** Width the PR panel starts at. */
export const DEFAULT_PR_PANEL_WIDTH = 46;
/** Narrowest the PR panel gets; below this it hides instead. */
export const MIN_PR_PANEL_WIDTH = 34;

/**
 * Fit the sidebar and the PR panel around the content pane. The sidebar leaves
 * room for the panel when it's wanted; the content pane always keeps
 * MIN_CONTENT_WIDTH; a panel that can't get its minimum is hidden (width 0).
 * A hidden sidebar (`b`) takes no room at all.
 */
export function fitPanels(
  screenWidth: number,
  sidebarWidth: number,
  panelWidth: number,
  panelWanted: boolean,
  sidebarHidden = false,
): { sidebar: number; panel: number } {
  const sidebar = sidebarHidden
    ? 0
    : clampSidebarWidth(sidebarWidth, screenWidth - (panelWanted ? MIN_PR_PANEL_WIDTH : 0));
  if (!panelWanted) return { sidebar, panel: 0 };
  const room = screenWidth - sidebar - MIN_CONTENT_WIDTH;
  if (room < MIN_PR_PANEL_WIDTH) return { sidebar, panel: 0 };
  return { sidebar, panel: Math.min(Math.max(Math.round(panelWidth), MIN_PR_PANEL_WIDTH), room) };
}
