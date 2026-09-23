import { describe, expect, test } from "bun:test";
import {
  MIN_CONTENT_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
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
