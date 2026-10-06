/**
 * Resizing the sidebar: drag its right-edge divider, or `[` / `]` / `=` from
 * the keyboard. The width is clamped to the screen and remembered in state.json.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_SIDEBAR_WIDTH, MIN_CONTENT_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_WIDTH_STEP } from "../../src/layout";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { settle, waitForText, waitUntil } from "../helpers/frame";
import { makeRepo } from "../helpers/repo";
import { createSandbox, type Sandbox } from "../helpers/sandbox";
import { ICON } from "../../src/icons";

const SCREEN = 100; // renderApp's default width
const DEFAULT_COL = DEFAULT_SIDEBAR_WIDTH - 1; // the divider is the sidebar's last column

let sandbox: Sandbox;
let app: RenderedApp;

beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => {
  app?.dispose();
  sandbox.cleanup();
});

/** A worktree name too long for the default sidebar. */
const NAME = "a-worktree-name-too-long-for-the-sidebar";

/** One project in state, optionally with a remembered sidebar width. */
async function oneProject(sidebarWidth?: number) {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: `feature/${NAME}` }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  if (sidebarWidth !== undefined) state.ui = { sidebarWidth };
  await saveState(state);
  await reconcile(state);
}

/**
 * The divider's column. The top row is blank on both sides of it (the sidebar
 * has top padding, the placeholder pane is vertically centred), so the only
 * glyph there is the divider line itself.
 */
function dividerColumn(app: RenderedApp): number {
  return (app.captureCharFrame().split("\n")[0] ?? "").indexOf("│");
}

function waitForDivider(app: RenderedApp, col: number) {
  return waitUntil(app, () => dividerColumn(app) === col, `the divider at column ${col}`);
}

/** The worktree's row, as the sidebar shows it (its name cut short to fit). */
function shownRow(app: RenderedApp): string {
  const row =
    app
      .captureCharFrame()
      .split("\n")
      .find((l) => l.includes(`${ICON.noAgent} a-worktree`)) ?? "";
  return row.slice(0, dividerColumn(app)).replace(/│/g, "").trim();
}

function storedWidth(): number | undefined {
  return sandbox.readState()?.ui?.sidebarWidth;
}

async function start(sidebarWidth?: number) {
  await oneProject(sidebarWidth);
  app = await renderApp();
  await waitForText(app, `${ICON.noAgent} a-worktree`);
}

describe("dragging the divider", () => {
  test("starts at the default width", async () => {
    await start();
    expect(dividerColumn(app)).toBe(DEFAULT_COL);
  });

  test("resizes the sidebar live and remembers the width", async () => {
    await start();
    const before = shownRow(app);
    await app.mockMouse.drag(DEFAULT_COL, 10, 50, 10);
    await waitForDivider(app, 50);
    // The wider sidebar shows more of the worktree's name — all of it.
    expect(before).not.toEndWith(NAME);
    expect(shownRow(app)).toEndWith(NAME);
    await waitUntil(app, () => storedWidth() === 51, "the width to be saved");
  });

  test("a remembered width is restored on the next launch", async () => {
    await start(56);
    expect(dividerColumn(app)).toBe(55);
  });

  test("can't be dragged narrower than the minimum", async () => {
    await start();
    await app.mockMouse.drag(DEFAULT_COL, 10, 2, 10);
    await waitForDivider(app, MIN_SIDEBAR_WIDTH - 1);
  });

  test("can't be dragged so wide it crowds out the terminal", async () => {
    await start();
    await app.mockMouse.drag(DEFAULT_COL, 10, SCREEN - 1, 10);
    await waitForDivider(app, SCREEN - MIN_CONTENT_WIDTH - 1);
  });

  test("grabbing it again right after a drag keeps resizing (no accidental reset)", async () => {
    await start();
    await app.mockMouse.drag(DEFAULT_COL, 10, 50, 10);
    await waitForDivider(app, 50);
    // The frame the real render loop draws right after the release (while the
    // divider was captured it was left out of the hit grid).
    await settle(app);
    // Grab it again immediately — well inside the double-click window.
    await app.mockMouse.drag(50, 10, 44, 10);
    await waitForDivider(app, 44);
  });

  test("double-clicking it resets to the default and forgets the custom width", async () => {
    await start(56);
    await app.mockMouse.doubleClick(55, 10);
    await waitForDivider(app, DEFAULT_COL);
    await waitUntil(app, () => storedWidth() === undefined, "the custom width to be dropped");
    expect(sandbox.readState()?.repos).toHaveLength(1); // the rest of state is untouched
  });
});

describe("keyboard", () => {
  test("] widens and [ narrows by a step, and the result is saved", async () => {
    await start();
    app.mockInput.pressKey("]");
    await waitForDivider(app, DEFAULT_COL + SIDEBAR_WIDTH_STEP);
    app.mockInput.pressKey("[");
    app.mockInput.pressKey("[");
    await waitForDivider(app, DEFAULT_COL - SIDEBAR_WIDTH_STEP);
    await waitUntil(app, () => storedWidth() === DEFAULT_SIDEBAR_WIDTH - SIDEBAR_WIDTH_STEP, "the width to be saved");
  });

  test("a burst of ] presses moves one step each", async () => {
    await start();
    // No awaits in between: key repeat arrives in one tick.
    app.mockInput.pressKey("]");
    app.mockInput.pressKey("]");
    app.mockInput.pressKey("]");
    await waitForDivider(app, DEFAULT_COL + 3 * SIDEBAR_WIDTH_STEP);
  });

  test("= resets to the default", async () => {
    await start(60);
    app.mockInput.pressKey("=");
    await waitForDivider(app, DEFAULT_COL);
  });
});

describe("window resizing", () => {
  test("a narrower window squeezes the sidebar, and widening restores the chosen width", async () => {
    await start(70); // the widest a 100-column screen allows
    expect(dividerColumn(app)).toBe(69);

    app.resize(80, 30);
    await settle(app);
    await waitForDivider(app, 80 - MIN_CONTENT_WIDTH - 1);

    app.resize(SCREEN, 30);
    await settle(app);
    await waitForDivider(app, 69);
  });
});
