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
const TERMINAL_SHOWN = "^g sidebar";

async function start() {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/x" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  app = await renderApp();
  await waitForText(app, "feature/x");
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
    const { y } = locate("no agent activity");
    await app.mockMouse.click(3, y);
    expect(await sidebarHasKeys()).toBe(true);
  });

  test("a worktree row shows its terminal and keeps the keyboard in the sidebar", async () => {
    await start();
    const { x, y } = locate("· x");
    await app.mockMouse.click(x + 2, y);
    await waitForText(app, TERMINAL_SHOWN);
    await waitForSelection(app, "x");
    expect(await sidebarHasKeys()).toBe(true);
    // …so j/k navigate from the clicked row.
    app.mockInput.pressKey("k");
    await waitForSelection(app, "main");
  });

  test("double-clicking a worktree row types in its terminal", async () => {
    await start();
    const { x, y } = locate("· x");
    await app.mockMouse.doubleClick(x + 2, y);
    await waitForText(app, TERMINAL_SHOWN);
    expect(await sidebarHasKeys()).toBe(false);
  });

  test("a project header still folds, and keeps the keyboard", async () => {
    await start();
    await openTerminalWithKeys();
    const { x, y } = locate("widget");
    await app.mockMouse.click(x, y);
    await waitForTextGone(app, "feature/x");
    expect(await sidebarHasKeys()).toBe(true);
  });
});
