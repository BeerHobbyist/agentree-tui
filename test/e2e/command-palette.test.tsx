/**
 * The command palette: `ctrl+p` lists every action that applies — grouped,
 * each with its key — typing narrows it, and Enter (or a click) runs one.
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

/** feature/login with an open PR #42, selected. */
async function start() {
  const root = await makeRepo(join(sandbox.workspace, "widget"), { worktrees: [{ branch: "feature/login" }] });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  sandbox.setBranchPr({ number: 42, title: "Add login screen", headRefName: "feature/login" }, "feature/login");
  app = await renderApp({ width: 140, height: 40 });
  await waitForText(app, "· login");
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "login");
  await waitForText(app, "⇡#42");
}

/** ctrl+p, and wait until it takes keys (its handler is attached once it's on screen). */
async function openPalette() {
  app.mockInput.pressKey("p", { ctrl: true });
  await waitForText(app, "Commands");
  await Bun.sleep(100);
}

async function type(text: string) {
  for (const ch of text) app.mockInput.pressKey(ch);
  await waitForText(app, `❯ ${text}`);
}

describe("the command palette", () => {
  test("ctrl+p lists what you can do, grouped, each with its key", async () => {
    await start();
    await openPalette();
    const frame = app.captureCharFrame();
    for (const heading of ["Worktree", "Pull request", "Agents", "Projects"]) expect(frame).toContain(heading);
    expect(frame).toMatch(/Merge pull request\s+#42\s+m/);
    expect(frame).toMatch(/Close worktree\s+login\s+d/);
  });

  test("typing narrows it; Enter runs the one selected", async () => {
    await start();
    await openPalette();
    await type("merge");
    const frame = app.captureCharFrame();
    expect(frame).toContain("▶ Merge pull request");
    expect(frame).not.toContain("Close worktree");
    app.mockInput.pressEnter();
    await waitForTextGone(app, "Commands");
    await waitForText(app, "Merge #42"); // the merge dialog, as `m` opens it
  });

  test("esc closes it, and the sidebar has its keys back", async () => {
    await start();
    await openPalette();
    app.mockInput.pressEscape();
    await waitForTextGone(app, "Commands");
    app.mockInput.pressKey("k");
    await waitForSelection(app, "main");
  });

  test("it offers only what applies: the main copy can't be closed, and without a PR there's nothing to merge", async () => {
    await start();
    app.mockInput.pressKey("k"); // main
    await waitForSelection(app, "main");
    await openPalette();
    const frame = app.captureCharFrame();
    expect(frame).not.toContain("Close worktree");
    expect(frame).not.toContain("Merge pull request");
    expect(frame).toContain("New worktree");
  });

  test("a click runs a command too", async () => {
    await start();
    await openPalette();
    await type("theme");
    const lines = app.captureCharFrame().split("\n");
    const y = lines.findIndex((l) => l.includes("Switch theme"));
    await app.mockMouse.click(lines[y]!.indexOf("Switch theme") + 2, y);
    await waitForTextGone(app, "Commands");
    await waitForText(app, "◑ midnight"); // the toast naming the theme
  });
});
