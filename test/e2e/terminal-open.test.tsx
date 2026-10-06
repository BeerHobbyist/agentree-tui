/**
 * Opening a terminal: it's in the theme's colours from the first frame. tmux
 * clears the whole screen when it attaches and repaints it row by row; a
 * cleared cell shows the emulator's default background, which used to be
 * black — a black block flashed at the bottom of every new terminal.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { waitForSelection, waitForText } from "../helpers/frame";
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

/** Rows with cells painted pure black — no theme has it, so it can only be the emulator's default. */
function blackRows(): number[] {
  const rows: number[] = [];
  app.captureSpans().lines.forEach((line, y) => {
    const black = line.spans.some((s) => {
      const [r, g, b, a] = s.bg.buffer;
      return (a ?? 0) > 0 && r === 0 && g === 0 && b === 0;
    });
    if (black) rows.push(y);
  });
  return rows;
}

test("a new terminal never shows black while tmux attaches and repaints", async () => {
  const root = await makeRepo(join(sandbox.workspace, "widget"), { worktrees: [{ branch: "feature/x" }] });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  app = await renderApp();
  await waitForText(app, `${ICON.noAgent} x`);
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "feature/x");

  app.mockInput.pressEnter();
  // Every frame for the next two seconds: the attach and its repaint.
  const seen = new Set<number>();
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    for (const y of blackRows()) seen.add(y);
    await Bun.sleep(5);
  }
  await waitForText(app, "^g"); // it did open
  expect([...seen]).toEqual([]);
});
