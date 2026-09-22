/**
 * Checking out an open PR from the add-worktree modal: the PR rows, and the
 * `refs/pull/<n>/head` fetch that backs them (the path that also works for
 * PRs from forks, where the branch does not exist on origin).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderApp, type RenderedApp } from "../helpers/app";
import { waitForModalClosed, waitForText, waitUntil } from "../helpers/frame";
import { addPrHead, git, makeRemote } from "../helpers/repo";
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

/** Open the modal on a freshly cloned acme/widget and land on the actions list. */
async function openActionsFor(app: RenderedApp) {
  app.mockInput.pressKey("n");
  await waitForText(app, "acme/widget");
  app.mockInput.pressEnter();
  await waitForText(app, "Create new worktree");
}

describe("the PR rows", () => {
  test("picking a PR fetches its head and creates the worktree on that branch", async () => {
    const remote = await makeRemote(sandbox, "acme/widget");
    await addPrHead(remote, 7, "contributor-fix");
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }]);
    sandbox.setOpenPrs([{ number: 7, title: "Fix the thing", headRefName: "contributor-fix" }]);

    app = await renderApp();
    await openActionsFor(app);
    await waitForText(app, "⇄ #7 Fix the thing");

    // Rows: create new, the main copy, then the PRs.
    app.mockInput.pressArrow("down");
    app.mockInput.pressArrow("down");
    app.mockInput.pressEnter();

    await waitForModalClosed(app);
    await waitUntil(
      app,
      () => sandbox.readState()?.repos[0]?.worktrees.length === 1,
      "the PR worktree to be registered",
    );

    const root = join(sandbox.workspace, "widget");
    const stored = sandbox.readState()!.repos[0]!.worktrees[0]!;
    expect(stored).toMatchObject({
      id: "contributor-fix",
      branch: "contributor-fix",
      path: join(root, ".worktrees", "contributor-fix"),
    });
    // The branch carries the PR's commit, fetched through refs/pull/7/head.
    expect(existsSync(join(root, ".worktrees", "contributor-fix", "pr-7.txt"))).toBe(true);
    expect(await git(["log", "-1", "--format=%s", "contributor-fix"], root)).toContain("pr 7");
    await waitForText(app, "contributor-fix");
  });

  test("a PR that already has a worktree is not offered twice", async () => {
    const remote = await makeRemote(sandbox, "acme/widget");
    await addPrHead(remote, 7, "contributor-fix");
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }]);
    sandbox.setOpenPrs([{ number: 7, title: "Fix the thing", headRefName: "contributor-fix" }]);

    app = await renderApp();
    await openActionsFor(app);
    await waitForText(app, "⇄ #7");
    app.mockInput.pressArrow("down");
    app.mockInput.pressArrow("down");
    app.mockInput.pressEnter();
    await waitForModalClosed(app);

    // Reopen: the PR now has a worktree, so only that worktree is listed.
    app.mockInput.pressKey("a");
    await waitForText(app, "Create new worktree");
    const frame = await waitForText(app, "contributor-fix");
    expect(frame).not.toContain("⇄ #7");
  });

  test("the modal still works when the PR lookup fails", async () => {
    await makeRemote(sandbox, "acme/widget");
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }]);
    sandbox.failGh("pr");

    app = await renderApp();
    await openActionsFor(app);
    // No PR rows, but creating a worktree by hand is unaffected.
    app.mockInput.pressEnter();
    await waitForText(app, "New branch name");
  });

  test("a PR whose head cannot be fetched reports the error and retries", async () => {
    await makeRemote(sandbox, "acme/widget"); // no refs/pull/9/head published
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }]);
    sandbox.setOpenPrs([{ number: 9, title: "Ghost", headRefName: "ghost" }]);

    app = await renderApp();
    await openActionsFor(app);
    await waitForText(app, "⇄ #9 Ghost");
    app.mockInput.pressArrow("down");
    app.mockInput.pressArrow("down");
    app.mockInput.pressEnter();

    await waitForText(app, "r retry · esc back");
    // esc goes back to the actions list, not to the branch-name prompt.
    app.mockInput.pressEscape();
    await waitForText(app, "Create new worktree");
  });
});
