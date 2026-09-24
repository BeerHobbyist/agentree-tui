/**
 * Hiding the sidebar (b, or its footer's ⇤) gives the terminal the whole
 * width; going back to the sidebar (Ctrl+g, the tab bar's ‹, or b) shows it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { settle, waitForSelection, waitForText, waitForTextGone, waitUntil } from "../helpers/frame";
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
/** Only the sidebar shows this: its project header. */
const SIDEBAR = "◈ widget";

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

/** Press `?` and report whether the app took it (help opened), then close help. */
async function appHasKeys(): Promise<boolean> {
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

/** Where `text` first appears on screen. */
function locate(text: string): { x: number; y: number } {
  const lines = app.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes(text));
  if (y < 0) throw new Error(`"${text}" not on screen`);
  return { x: lines[y]!.indexOf(text), y };
}

/** Open feature/x's terminal (it takes the keys), then come back to the sidebar. */
async function openTerminal() {
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "x");
  app.mockInput.pressEnter();
  await waitForText(app, "^g sidebar");
  app.mockInput.pressKey("g", { ctrl: true });
  await Bun.sleep(100);
}

describe("hiding the sidebar", () => {
  test("b hides it and b shows it again; remembered either way", async () => {
    await start();
    app.mockInput.pressKey("b");
    await waitForTextGone(app, SIDEBAR);
    await waitForText(app, "The sidebar is hidden — b shows it");
    await waitUntil(app, () => sandbox.readState()?.ui?.sidebarHidden === true, "the choice to be saved");

    app.mockInput.pressKey("b");
    await waitForText(app, SIDEBAR);
    await waitUntil(app, () => sandbox.readState()?.ui?.sidebarHidden === undefined, "shown to be saved");
  });

  test("with a terminal open, hiding hands it the keys and the whole width", async () => {
    await start();
    await openTerminal();
    expect(await appHasKeys()).toBe(true); // back in the sidebar

    app.mockInput.pressKey("b");
    await waitForTextGone(app, SIDEBAR);
    // The tab bar now starts at the left edge.
    await waitUntil(app, () => locate("‹").x <= 2, "the terminal to fill the width");
    expect(await appHasKeys()).toBe(false); // the terminal has them
  });

  test("Ctrl+g from the terminal shows the sidebar and gives it the keys", async () => {
    await start();
    await openTerminal();
    app.mockInput.pressKey("b");
    await waitForTextGone(app, SIDEBAR);
    app.mockInput.pressKey("g", { ctrl: true });
    await waitForText(app, SIDEBAR);
    expect(await appHasKeys()).toBe(true);
  });

  test("the ⇤ in its corner hides it; the tab bar's ‹ brings it back", async () => {
    await start();
    await openTerminal();
    const hide = locate("⇤");
    await app.mockMouse.click(hide.x, hide.y);
    await waitForTextGone(app, SIDEBAR);
    const back = locate("‹");
    await app.mockMouse.click(back.x, back.y);
    await waitForText(app, SIDEBAR);
  });

  test("a hidden sidebar stays hidden after a restart", async () => {
    await start();
    app.mockInput.pressKey("b");
    await waitUntil(app, () => sandbox.readState()?.ui?.sidebarHidden === true, "the choice to be saved");
    app.dispose();
    app = await renderApp();
    await waitForText(app, "b shows it");
    expect(app.captureCharFrame()).not.toContain(SIDEBAR);
  });
});
