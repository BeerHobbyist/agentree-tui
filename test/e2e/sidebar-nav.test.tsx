/**
 * Sidebar navigation driven by real keystrokes.
 *
 * The selection lives in state that the global key handler reads through a
 * ref, so several of these deliberately send keys in bursts — the way key
 * repeat and pasted input actually arrive.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { selection, settle, waitForSelection, waitForText, waitForTextGone, waitUntil } from "../helpers/frame";
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

/** Two projects in state: widget (main + two worktrees) and gadget (main). */
async function twoProjects() {
  const widget = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/x" }, { branch: "feature/y" }],
  });
  const gadget = await makeRepo(join(sandbox.workspace, "gadget"));
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root: widget });
  upsertRepo(state, { nameWithOwner: "acme/gadget", name: "gadget", root: gadget });
  await saveState(state);
  await reconcile(state); // adopt the on-disk worktrees, as startup would
  return { widget, gadget };
}

describe("moving the selection", () => {
  test("starts on the first project", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForSelection(app, "widget");
  });

  test("a burst of j keys moves one row each, not one row in total", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForSelection(app, "widget");

    // No awaits in between: all three arrive before React re-renders, which is
    // what key repeat does.
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j");

    // widget header → main → x → y
    await waitForSelection(app, "y");
  });

  test("k moves back up and stops at the top", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForSelection(app, "widget");

    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j");
    await waitForSelection(app, "x");

    for (let i = 0; i < 4; i++) app.mockInput.pressKey("k");
    await waitForSelection(app, "widget");
  });

  test("G jumps to the last row and g back to the first", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForSelection(app, "widget");

    // Shift+G arrives as name "g" with the shift flag — the app has to look at
    // the modifier, not at an uppercase name.
    app.mockInput.pressKey("G", { shift: true });
    await waitForSelection(app, "main");
    expect(selection(app)).not.toContain("widget");

    app.mockInput.pressKey("g");
    await waitForSelection(app, "widget");
  });

  test("arrow keys work like j and k", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForSelection(app, "widget");

    app.mockInput.pressArrow("down");
    await waitForSelection(app, "main");
    app.mockInput.pressArrow("up");
    await waitForSelection(app, "widget");
  });

  test("j stops at the last row", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForSelection(app, "widget");

    for (let i = 0; i < 20; i++) app.mockInput.pressKey("j");
    await waitForSelection(app, "main"); // gadget's main, the last row
    await settle(app);
    expect(selection(app)).toContain("main");
  });
});

describe("a list taller than the sidebar", () => {
  /** widget with main + eight worktrees — more cards than a 20-row screen shows. */
  async function manyWorktrees() {
    const widget = await makeRepo(join(sandbox.workspace, "widget"), {
      worktrees: Array.from({ length: 8 }, (_, i) => ({ branch: `feature/w${i + 1}` })),
    });
    const state = loadState();
    upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root: widget });
    await saveState(state);
    await reconcile(state);
  }
  const HEADER = `${ICON.repo} widget`;

  test("scrolls to keep the selection in view, and back", async () => {
    await manyWorktrees();
    app = await renderApp({ height: 20 });
    await waitForSelection(app, "widget");
    expect(app.captureCharFrame()).not.toContain("feature/w8");

    app.mockInput.pressKey("G");
    await waitForSelection(app, "feature/w8");
    await waitForText(app, "feature/w8");
    await waitForTextGone(app, HEADER); // scrolled past it

    app.mockInput.pressKey("g");
    await waitForSelection(app, "widget");
    await waitForText(app, HEADER);
    expect(app.captureCharFrame()).not.toContain("feature/w8");
  });

  test("folding it so it fits moves nothing sideways (no scrollbar comes and goes)", async () => {
    await manyWorktrees();
    app = await renderApp({ height: 20 });
    await waitForSelection(app, "widget");
    const addColumn = () => {
      const lines = app.captureCharFrame().split("\n");
      return lines.find((l) => l.includes(HEADER))!.indexOf(ICON.add);
    };
    const before = addColumn();
    app.mockInput.pressKey("h"); // fold widget: the list now fits
    await waitForTextGone(app, "feature/w1");
    expect(addColumn()).toBe(before);
  });

  test("moving down one row at a time never loses the selection off screen", async () => {
    await manyWorktrees();
    app = await renderApp({ height: 20 });
    await waitForSelection(app, "widget");
    for (let i = 1; i <= 8; i++) {
      app.mockInput.pressKey("j"); // main, then w1…w7
    }
    app.mockInput.pressKey("j");
    await waitForSelection(app, "feature/w8");
    await waitForText(app, "feature/w8");
  });
});

describe("folding projects", () => {
  test("h folds a project away and l unfolds it", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForText(app, "feature/x");

    app.mockInput.pressKey("h");
    await waitForTextGone(app, "feature/x");

    app.mockInput.pressKey("l");
    await waitForText(app, "feature/x");
  });

  test("space toggles, and folding snaps the selection to the header", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForText(app, "feature/x");

    app.mockInput.pressKey("j"); // onto widget's main
    await waitForSelection(app, "main");
    app.mockInput.pressKey(" ");
    await waitForTextGone(app, "feature/x");
    expect(selection(app)).toContain("widget");

    app.mockInput.pressKey(" ");
    await waitForText(app, "feature/x");
  });

  test("enter on a project header folds it rather than opening anything", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForText(app, "feature/x");

    app.mockInput.pressEnter();
    await waitForTextGone(app, "feature/x");
  });

  test("folding one project leaves the other alone", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForText(app, "feature/x");

    app.mockInput.pressKey("h");
    await waitForTextGone(app, "feature/x");
    expect(app.captureCharFrame()).toContain("gadget");
  });
});

describe("worktrees that vanished", () => {
  test("are listed but cannot be opened", async () => {
    const { widget } = await twoProjects();
    rmSync(join(widget, ".worktrees", "feature-x"), { recursive: true, force: true });

    app = await renderApp();
    await waitForText(app, "feature/x");

    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j"); // onto the missing worktree
    await waitForSelection(app, "x");
    app.mockInput.pressEnter();
    await settle(app);

    // No terminal pane: the placeholder says why, and what to do.
    expect(app.captureCharFrame()).toContain("gone from disk · d forget it");
  });
});

describe("quitting and help", () => {
  test("q quits while the sidebar has focus", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForSelection(app, "widget");

    app.mockInput.pressKey("q");
    await waitUntil(app, () => app.quitCount() > 0, "the app to quit");
  });

  test("? then q in one burst closes help — it doesn't quit", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForSelection(app, "widget");

    // Both keys in the same tick, before React re-renders (a fast typist, or a paste).
    app.mockInput.pressKey("?");
    app.mockInput.pressKey("q");
    await Bun.sleep(200);
    expect(app.quitCount()).toBe(0);
    expect(app.captureCharFrame()).not.toContain("Keyboard & mouse");
  });

  test("ctrl+c quits too", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForSelection(app, "widget");

    app.mockInput.pressCtrlC();
    await waitUntil(app, () => app.quitCount() > 0, "the app to quit");
  });

  test("the help overlay swallows navigation and closes without quitting", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForSelection(app, "widget");

    app.mockInput.pressKey("?");
    await waitForText(app, "Keyboard & mouse");

    app.mockInput.pressKey("j"); // inert while help is up
    await settle(app);
    app.mockInput.pressKey("q"); // closes help instead of quitting
    await waitForTextGone(app, "Keyboard & mouse");
    expect(app.quitCount()).toBe(0);
    await waitForSelection(app, "widget");
  });
});

describe("themes", () => {
  test("t cycles the palette and the footer says which one is live", async () => {
    await twoProjects();
    app = await renderApp();
    await waitForText(app, "onedark");

    app.mockInput.pressKey("t");
    await waitForText(app, "midnight");

    app.mockInput.pressKey("t");
    await waitForText(app, "opencode");

    app.mockInput.pressKey("t");
    await waitForText(app, "onedark");
  });
});
