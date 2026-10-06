/**
 * Focus follows the click: clicking the sidebar gives it the keyboard, a
 * single click on a worktree shows its terminal without taking the keyboard,
 * and a double-click (or Enter) types in it.
 *
 * Where the keyboard is shows through `?`: the sidebar opens the help overlay,
 * a focused terminal sends it to the shell instead.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { settle, waitForSelection, waitForText, waitForTextGone } from "../helpers/frame";
import { makeRepo } from "../helpers/repo";
import { createSandbox, type Sandbox } from "../helpers/sandbox";
import { ICON } from "../../src/icons";

let sandbox: Sandbox;
let app: RenderedApp;

beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => {
  app?.dispose();
  sandbox.cleanup();
});

const HELP = "Keyboard & mouse";
/** The tab bar's hint — on screen once a worktree's terminal is showing. */
const TERMINAL_SHOWN = "^g";

async function start(height?: number) {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/x" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  app = await renderApp({ height });
  await waitForText(app, `${ICON.noAgent} x`);
}

/** Where `text` first appears on screen (single-width text before it). */
function locate(text: string): { x: number; y: number } {
  const lines = app.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes(text));
  if (y < 0) throw new Error(`"${text}" not on screen`);
  return { x: lines[y]!.indexOf(text), y };
}

/** Press `?` and report whether the sidebar took it (help opened), then close help. */
async function sidebarHasKeys(): Promise<boolean> {
  app.mockInput.pressKey("?");
  for (let i = 0; i < 15; i++) {
    await Bun.sleep(20);
    await settle(app);
    if (app.captureCharFrame().includes(HELP)) {
      app.mockInput.pressKey("q");
      await waitForTextGone(app, HELP);
      return true;
    }
  }
  return false;
}

/** Enter on feature/x: its terminal opens with the keyboard. */
async function openTerminalWithKeys() {
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "x");
  app.mockInput.pressEnter();
  await waitForText(app, TERMINAL_SHOWN);
  expect(await sidebarHasKeys()).toBe(false); // the terminal has them
}

describe("clicking the sidebar", () => {
  test("empty sidebar space takes the keyboard back from the terminal", async () => {
    await start();
    await openTerminalWithKeys();
    await app.mockMouse.click(5, 20); // below the project, above the footer
    expect(await sidebarHasKeys()).toBe(true);
  });

  test("the footer does too", async () => {
    await start();
    await openTerminalWithKeys();
    const { y } = locate(ICON.theme);
    await app.mockMouse.click(3, y);
    expect(await sidebarHasKeys()).toBe(true);
  });

  test("a worktree row shows its terminal and keeps the keyboard in the sidebar", async () => {
    await start();
    const { x, y } = locate(`${ICON.noAgent} x`);
    await app.mockMouse.click(x + 2, y);
    await waitForText(app, TERMINAL_SHOWN);
    await waitForSelection(app, "x");
    expect(await sidebarHasKeys()).toBe(true);
    // …so j/k navigate from the clicked row.
    app.mockInput.pressKey("k");
    await waitForSelection(app, "main");
  });

  test("a card cut off at the bottom is selected where it is: the list doesn't scroll", async () => {
    await start(11); // x's card shows only its top lines
    // Rows in the sidebar only: the terminal pane may say "widget" too.
    const row = (text: string) =>
      app
        .captureCharFrame()
        .split("\n")
        .findIndex((l) => l.slice(0, 36).includes(text));
    const before = { header: row(`${ICON.repo} widget`), card: row(`${ICON.noAgent} x`) };
    const { x, y } = locate(`${ICON.noAgent} x`);
    await app.mockMouse.click(x + 2, y);
    await waitForSelection(app, "x");
    expect({ header: row(`${ICON.repo} widget`), card: row(`${ICON.noAgent} x`) }).toEqual(before);
  });

  test("double-clicking a worktree row types in its terminal", async () => {
    await start();
    const { x, y } = locate(`${ICON.noAgent} x`);
    await app.mockMouse.doubleClick(x + 2, y);
    await waitForText(app, TERMINAL_SHOWN);
    expect(await sidebarHasKeys()).toBe(false);
  });

  test("a project header still folds, and keeps the keyboard", async () => {
    await start();
    await openTerminalWithKeys();
    const { x, y } = locate("widget");
    await app.mockMouse.click(x, y);
    await waitForTextGone(app, `${ICON.noAgent} x`);
    expect(await sidebarHasKeys()).toBe(true);
  });
});

describe("on a short screen", () => {
  test("the terminal's tab bar still shows", async () => {
    const root = await makeRepo(join(sandbox.workspace, "widget"), { worktrees: [{ branch: "feature/x" }] });
    const state = loadState();
    upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
    await saveState(state);
    await reconcile(state);
    app = await renderApp({ width: 100, height: 14 });
    await waitForText(app, `${ICON.noAgent} x`);
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j");
    await waitForSelection(app, "x");
    app.mockInput.pressEnter();
    await waitForText(app, TERMINAL_SHOWN); // it used to be squeezed out below ~20 rows
  });
});
