/**
 * Closing (deleting) a worktree with the `d` shortcut: real keystrokes drive a
 * confirm prompt, then the worktree is actually gone from disk, the sidebar,
 * and persisted state.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { settle, waitForSelection, waitForText, waitForTextGone, waitUntil } from "../helpers/frame";
import { git, makeRepo } from "../helpers/repo";
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

/** One project: main + a "feature/x" worktree. */
async function oneProject() {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/x" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state); // adopt the on-disk worktrees, as startup would
  return root;
}

async function selectFeatureX(app: RenderedApp) {
  await waitForText(app, "feature/x");
  app.mockInput.pressKey("j"); // onto main
  app.mockInput.pressKey("j"); // onto x
  await waitForSelection(app, "x");
}

describe("closing a worktree", () => {
  test("d prompts, y deletes it from disk, the sidebar, and state", async () => {
    const root = await oneProject();

    app = await renderApp();
    await selectFeatureX(app);

    app.mockInput.pressKey("d");
    const frame = await waitForText(app, "Close worktree");
    expect(frame).toContain('Delete "x" from disk?');

    app.mockInput.pressKey("y");
    await waitForTextGone(app, "Close worktree");
    await waitForTextGone(app, "feature/x");

    expect(existsSync(join(root, ".worktrees", "feature-x"))).toBe(false);
    expect(await git(["worktree", "list"], root)).not.toContain("feature-x");
    await waitUntil(
      app,
      () => sandbox.readState()?.repos[0]?.worktrees.length === 0,
      "the worktree to be dropped from state",
    );
  });

  test("n cancels — the worktree stays untouched", async () => {
    const root = await oneProject();

    app = await renderApp();
    await selectFeatureX(app);

    app.mockInput.pressKey("d");
    await waitForText(app, "Close worktree");
    app.mockInput.pressKey("n");
    await waitForTextGone(app, "Close worktree");

    await settle(app);
    expect(app.captureCharFrame()).toContain("feature/x");
    expect(existsSync(join(root, ".worktrees", "feature-x"))).toBe(true);
  });

  test("esc cancels too", async () => {
    await oneProject();
    app = await renderApp();
    await selectFeatureX(app);

    app.mockInput.pressKey("d");
    await waitForText(app, "Close worktree");
    app.mockInput.pressEscape();
    await waitForTextGone(app, "Close worktree");
    await waitForText(app, "feature/x");
  });

  test("a missing worktree can be closed too — it just forgets it", async () => {
    const root = await oneProject();
    rmSync(join(root, ".worktrees", "feature-x"), { recursive: true, force: true });

    app = await renderApp();
    await selectFeatureX(app);

    app.mockInput.pressKey("d");
    await waitForText(app, "Already gone on disk");
    app.mockInput.pressKey("y");
    await waitForTextGone(app, "feature/x");
    await waitUntil(
      app,
      () => sandbox.readState()?.repos[0]?.worktrees.length === 0,
      "the missing worktree to be forgotten",
    );
  });

  test("the main working copy can't be closed this way", async () => {
    await oneProject();
    app = await renderApp();
    await waitForText(app, "feature/x");
    app.mockInput.pressKey("j"); // onto main
    await waitForSelection(app, "main");

    app.mockInput.pressKey("d");
    await waitForText(app, "Could not close worktree");

    app.mockInput.pressEscape();
    await waitForTextGone(app, "Could not close worktree");
    await waitForText(app, "main");
  });

  test("a project header ignores d", async () => {
    await oneProject();
    app = await renderApp();
    await waitForSelection(app, "widget");

    app.mockInput.pressKey("d");
    await settle(app);
    expect(app.captureCharFrame()).not.toContain("Close worktree");
  });
});
