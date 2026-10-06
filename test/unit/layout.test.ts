import { describe, expect, test } from "bun:test";
import {
  MIN_CONTENT_WIDTH,
  MIN_PR_PANEL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
  fitPanels,
} from "../../src/layout";

describe("clampSidebarWidth", () => {
  test("leaves a width that fits alone", () => {
    expect(clampSidebarWidth(50, 120)).toBe(50);
  });

  test("never goes below the minimum", () => {
    expect(clampSidebarWidth(3, 120)).toBe(MIN_SIDEBAR_WIDTH);
  });

  test("always leaves the content pane its minimum", () => {
    expect(clampSidebarWidth(200, 120)).toBe(120 - MIN_CONTENT_WIDTH);
  });

  test("on a screen too narrow for both, the sidebar keeps its minimum", () => {
    expect(clampSidebarWidth(40, 40)).toBe(MIN_SIDEBAR_WIDTH);
  });

  test("rounds fractional widths to whole columns", () => {
    expect(clampSidebarWidth(40.6, 120)).toBe(41);
  });
});

describe("fitPanels", () => {
  test("without the PR panel, the sidebar is clamped as usual", () => {
    expect(fitPanels(140, 38, 46, false)).toEqual({ sidebar: 38, panel: 0 });
  });

  test("both fit side by side on a wide screen", () => {
    expect(fitPanels(140, 38, 46, true)).toEqual({ sidebar: 38, panel: 46 });
  });

  test("the sidebar keeps its width for the panel: the panel gets what's left, or hides", () => {
    expect(fitPanels(100, 38, 46, true)).toEqual({ sidebar: 38, panel: 0 });
    expect(fitPanels(100, 34, 46, true)).toEqual({ sidebar: 34, panel: 36 });
  });

  test("a PR on screen or not, the sidebar is the same width", () => {
    for (const screen of [80, 90, 100, 120, 140]) {
      for (const width of [MIN_SIDEBAR_WIDTH, 38, 60]) {
        expect(fitPanels(screen, width, 46, true).sidebar).toBe(fitPanels(screen, width, 46, false).sidebar);
      }
    }
  });

  test("a panel dragged too wide still leaves the content its minimum", () => {
    const { sidebar, panel } = fitPanels(140, 38, 200, true);
    expect(140 - sidebar - panel).toBe(MIN_CONTENT_WIDTH);
  });

  test("on a screen too narrow for all three, the panel hides", () => {
    expect(fitPanels(80, 38, 46, true).panel).toBe(0);
  });

  test("a hidden sidebar takes no room, which the panel can then use", () => {
    expect(fitPanels(140, 38, 46, false, true)).toEqual({ sidebar: 0, panel: 0 });
    expect(fitPanels(140, 38, 46, true, true)).toEqual({ sidebar: 0, panel: 46 });
    // The narrow screen that had no room for the panel now does.
    expect(fitPanels(80, 38, 46, true, true).panel).toBeGreaterThanOrEqual(MIN_PR_PANEL_WIDTH);
  });
});
