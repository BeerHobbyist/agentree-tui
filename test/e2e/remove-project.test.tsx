/**
 * Removing a project with `d` on its header: a confirm prompt, then it's gone
 * from the sidebar and persisted state and its terminals end — while the clone
 * and its worktrees stay on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { sessionName } from "../../src/services/tmux";
import { renderApp, type RenderedApp } from "../helpers/app";
import { settle, waitForSelection, waitForText, waitForTextGone, waitUntil } from "../helpers/frame";
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

const SESSION = sessionName("acme/widget", "feature-x");

function hasSession(session: string): boolean {
  return (
    Bun.spawnSync(["tmux", "-L", sandbox.tmuxSocket, "has-session", "-t", `=${session}`], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  );
}

/** One project: main + a "feature/x" worktree. */
async function oneProject() {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/x" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  return root;
}

describe("removing a project", () => {
  test("d on its header prompts; y forgets it and ends its terminals, leaving the files", async () => {
    const root = await oneProject();
    app = await renderApp();
    await waitForText(app, `${ICON.noAgent} x`);

    // Open feature/x's terminal, so it has a tmux session to end.
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j");
    await waitForSelection(app, "x");
    app.mockInput.pressEnter();
    await waitUntil(app, () => hasSession(SESSION), "feature/x's tmux session");
    app.mockInput.pressKey("g", { ctrl: true }); // back to the sidebar

    app.mockInput.pressKey("g");
    await waitForSelection(app, "widget");
    app.mockInput.pressKey("d");
    await waitForText(app, "Remove widget and its worktrees from agentree?");
    app.mockInput.pressKey("y");

    await waitForText(app, "Press n to add a project");
    expect(app.captureCharFrame()).not.toContain("feature/x");
    await waitUntil(app, () => sandbox.readState()?.repos.length === 0, "the project to be dropped from state");
    await waitUntil(app, () => !hasSession(SESSION), "its tmux session to end");
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, ".worktrees", "feature-x"))).toBe(true);
  });

  test("a project whose clone is gone can be removed too, ending main's session", async () => {
    const root = await oneProject();
    const main = sessionName("acme/widget", "main");
    Bun.spawnSync(["tmux", "-L", sandbox.tmuxSocket, "new-session", "-d", "-s", main]);
    expect(hasSession(main)).toBe(true);
    rmSync(root, { recursive: true, force: true });

    app = await renderApp();
    await waitForSelection(app, "widget");
    app.mockInput.pressKey("d");
    await waitForText(app, "Remove project");
    app.mockInput.pressKey("y");

    await waitForText(app, "Press n to add a project");
    await waitUntil(app, () => !hasSession(main), "main's tmux session to end");
    expect(sandbox.readState()?.repos).toEqual([]);
  });

  test("n cancels — the project stays", async () => {
    await oneProject();
    app = await renderApp();
    await waitForSelection(app, "widget");

    app.mockInput.pressKey("d");
    await waitForText(app, "Remove project");
    app.mockInput.pressKey("n");
    await waitForTextGone(app, "Remove project");

    await settle(app);
    expect(app.captureCharFrame()).toContain(`${ICON.noAgent} x`);
    expect(sandbox.readState()?.repos.map((r) => r.nameWithOwner)).toEqual(["acme/widget"]);
  });

  test("the command palette offers it on a header", async () => {
    await oneProject();
    app = await renderApp();
    await waitForSelection(app, "widget");

    app.mockInput.pressKey("p", { ctrl: true });
    await waitForText(app, "Commands");
    await Bun.sleep(100); // until it takes keys
    for (const ch of "remove") app.mockInput.pressKey(ch);
    const frame = await waitForText(app, `${ICON.search} remove`);
    expect(frame).toMatch(/Remove project\s+widget\s+d/);
    expect(frame).not.toContain("Close worktree");

    app.mockInput.pressEnter();
    await waitForText(app, "Remove widget and its worktrees from agentree?");
  });
});
