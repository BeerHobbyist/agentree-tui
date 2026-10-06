/**
 * The diff picker (⌥d in a terminal): its title names the viewer the diff
 * opens in, `v` switches between the installed ones (remembered), and the
 * chosen diff opens in a tmux tab of its own — or, from its commit list, a
 * range of the branch's commits.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sessionName } from "../../src/services/tmux";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { activeTab, waitForSelection, waitForText, waitForTextGone, waitUntil } from "../helpers/frame";
import { commitAll, makeRepo, writeFile } from "../helpers/repo";
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

const SESSION = sessionName("acme/widget", "feature-x");

/** What the diff tab shows (empty until it exists). */
function diffTab(): string {
  const out = Bun.spawnSync(["tmux", "-L", sandbox.tmuxSocket, "capture-pane", "-p", "-t", `${SESSION}:diff`]);
  return out.exitCode === 0 ? new TextDecoder().decode(out.stdout) : "";
}

/** feature/x's terminal open; returns the worktree's path. `viewers`: which are "installed". */
async function start(opts: { viewers?: string; saved?: string } = {}): Promise<string> {
  const root = await makeRepo(join(sandbox.workspace, "widget"), { worktrees: [{ branch: "feature/x" }] });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  if (opts.saved) state.ui = { diffViewer: opts.saved as "hunk" };
  await saveState(state);
  await reconcile(state);
  if (opts.viewers) process.env.AGENTREE_DIFF_VIEWERS = opts.viewers;
  app = await renderApp({ width: 120 });
  await waitForText(app, `${ICON.noAgent} x`);
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "x");
  app.mockInput.pressEnter();
  await waitForText(app, "^g");
  return join(root, ".worktrees", "feature-x");
}

async function openPicker() {
  app.mockInput.pressKey("d", { meta: true });
  await waitForText(app, "Open diff ·");
}

describe("the diff picker", () => {
  test("names the viewer; v switches to the next installed one, remembered", async () => {
    await start({ viewers: "delta,git" });
    await openPicker();
    await waitForText(app, "Open diff · delta");
    await waitForText(app, "v switches viewer · delta, git diff");

    app.mockInput.pressKey("v");
    await waitForText(app, "Open diff · git diff");
    await waitUntil(app, () => sandbox.readState()?.ui?.diffViewer === "git", "the choice to be saved");
    app.mockInput.pressKey("v");
    await waitForText(app, "Open diff · delta");
  });

  test("a saved viewer that's no longer installed falls back to what is", async () => {
    await start({ saved: "hunk" }); // only git "installed"
    await openPicker();
    await waitForText(app, "Open diff · git diff");
  });

  test("the working changes open in a diff tab of their own", async () => {
    const path = await start();
    writeFile(path, "README.md", "a change to review\n");
    await openPicker();
    app.mockInput.pressEnter(); // Working changes
    await waitUntil(app, () => diffTab().includes("+a change to review"), "the diff tab to show the change");
    await waitUntil(app, () => activeTab(app) === "diff", "the diff tab to be the one on screen");
  });

  test("an empty diff says so instead of the tab flashing shut", async () => {
    await start();
    await openPicker();
    app.mockInput.pressKey("j"); // Staged — nothing is
    app.mockInput.pressEnter();
    await waitUntil(app, () => diffTab().includes("No changes to show."), "the empty-diff message");
  });

  test("picked commits: a range from the branch's own, marked with space", async () => {
    const path = await start();
    for (const n of [1, 2, 3]) {
      writeFile(path, `f${n}.txt`, `change ${n}\n`);
      await commitAll(path, `feature ${n}`);
    }
    await openPicker();
    // Each key waits for the screen: ⏎ and space act on the row drawn last.
    for (let i = 0; i < 4; i++) app.mockInput.pressKey("j");
    await waitForSelection(app, "Pick commits…");
    app.mockInput.pressEnter();
    await waitForText(app, "Diff commits ·");
    await waitForText(app, "feature 1"); // newest first: feature 3, 2, 1 — not main's init
    await waitForText(app, "→ HEAD · 1 commit");

    app.mockInput.pressKey("j");
    await waitForSelection(app, "feature 2");
    app.mockInput.pressKey(" "); // marked: just feature 2
    await waitForTextGone(app, "→ HEAD");
    app.mockInput.pressKey("j");
    await waitForSelection(app, "feature 1");
    await waitForText(app, "· 2 commits");
    app.mockInput.pressEnter();
    await waitUntil(app, () => diffTab().includes("+change 2"), "the diff tab to show the picked commits");
    expect(diffTab()).toContain("+change 1");
    expect(diffTab()).not.toContain("+change 3");
  });
});
