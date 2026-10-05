/**
 * Toasts: something done (or failed) is said in the top-right corner and goes
 * away by itself — or on esc, or a click — without stopping you.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { waitForSelection, waitForText, waitForTextGone } from "../helpers/frame";
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

const TOAST = 'Closed "x"';

/** Close feature/x (d, y): a success toast follows. */
async function closeX() {
  const root = await makeRepo(join(sandbox.workspace, "widget"), { worktrees: [{ branch: "feature/x" }] });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  app = await renderApp();
  await waitForText(app, "· x");
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "feature/x");
  app.mockInput.pressKey("d");
  await waitForText(app, 'Delete "x" from disk?');
  app.mockInput.pressKey("y");
  await waitForText(app, TOAST);
}

describe("toasts", () => {
  test("closing a worktree says so in the corner; esc dismisses it", async () => {
    await closeX();
    // Top right, over whatever's there.
    const line = app
      .captureCharFrame()
      .split("\n")
      .find((l) => l.includes(TOAST))!;
    expect(line.indexOf(TOAST)).toBeGreaterThan(line.length / 2);
    app.mockInput.pressEscape();
    await waitForTextGone(app, TOAST);
  });

  test("a click dismisses it", async () => {
    await closeX();
    const lines = app.captureCharFrame().split("\n");
    const y = lines.findIndex((l) => l.includes(TOAST));
    await app.mockMouse.click(lines[y]!.indexOf(TOAST) + 1, y);
    await waitForTextGone(app, TOAST);
  });

  test("it goes away by itself", async () => {
    await closeX();
    await waitForTextGone(app, TOAST, { timeoutMs: 8000 });
  });
});
