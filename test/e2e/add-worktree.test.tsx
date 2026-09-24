/**
 * The add-worktree flow, end to end: real keystrokes into the real app, a fake
 * `gh` for the network, and real git underneath. Assertions are what the user
 * would see on screen, plus what ends up on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadState, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { settle, waitForModalClosed, waitForText, waitUntil } from "../helpers/frame";
import { git, makeRemote, makeRepo } from "../helpers/repo";
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

/** Register a repo in state as if it had been added in an earlier session. */
async function knownProject(nameWithOwner = "acme/widget", worktrees: { branch: string }[] = []) {
  const [, name = nameWithOwner] = nameWithOwner.split("/");
  const root = await makeRepo(join(sandbox.workspace, name), { worktrees });
  const state = loadState();
  upsertRepo(state, { nameWithOwner, name, root });
  await saveState(state);
  return root;
}

describe("adding a worktree from scratch", () => {
  test("n → pick a repo → clone → create a branch → it appears in the sidebar", async () => {
    await makeRemote(sandbox, "acme/widget");
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }, { nameWithOwner: "acme/gadget" }]);

    app = await renderApp();
    await settle(app);
    await waitForText(app, "Press n to add a project");

    app.mockInput.pressKey("n");
    await waitForText(app, "acme/widget");
    await waitForText(app, "2 repos");

    app.mockInput.pressEnter(); // acme/widget is first (most recently pushed)
    await waitForText(app, "Create new worktree");

    app.mockInput.pressEnter(); // "＋ Create new worktree" is row 0
    await waitForText(app, "New branch name");

    await app.mockInput.typeText("feature/x");
    await waitForText(app, "feature/x");
    app.mockInput.pressEnter();

    // The modal closes and the new worktree shows up under its project.
    await waitForModalClosed(app);
    const frame = await waitForText(app, "feature/x");
    expect(frame).toContain("widget");

    // …on disk, as a real git worktree…
    const root = join(sandbox.workspace, "widget");
    expect(existsSync(join(root, ".worktrees", "feature-x", "README.md"))).toBe(true);
    expect(await git(["worktree", "list"], root)).toContain("feature-x");

    // …and in the persisted state, so the next launch finds it.
    const stored = sandbox.readState()!.repos[0]!;
    expect(stored.nameWithOwner).toBe("acme/widget");
    expect(stored.worktrees).toHaveLength(1);
    expect(stored.worktrees[0]).toMatchObject({
      id: "feature-x",
      branch: "feature/x",
      name: "x",
      path: join(root, ".worktrees", "feature-x"),
    });
  });

  test("the filter narrows the list and Enter picks the highlighted repo", async () => {
    await makeRemote(sandbox, "acme/gadget");
    sandbox.setRepoPage(1, [
      { nameWithOwner: "acme/widget" },
      { nameWithOwner: "acme/gadget" },
      { nameWithOwner: "other/gadget-tools" },
    ]);

    app = await renderApp();
    app.mockInput.pressKey("n");
    await waitForText(app, "3 repos");

    await app.mockInput.typeText("gadget");
    // Exact name match ranks above the prefix match; the widget is filtered out.
    const frame = await waitForText(app, "2 repos");
    expect(frame).not.toContain("acme/widget");
    expect(frame.indexOf("acme/gadget")).toBeLessThan(frame.indexOf("other/gadget-tools"));

    app.mockInput.pressEnter();
    await waitForText(app, "Create new worktree");
    expect(sandbox.ghCalls().some((c) => c.startsWith("repo clone acme/gadget"))).toBe(true);
  });

  test("an already-cloned repo skips the clone", async () => {
    await knownProject("acme/widget");
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }]);

    app = await renderApp();
    app.mockInput.pressKey("n");
    await waitForText(app, "acme/widget");
    app.mockInput.pressEnter();

    await waitForText(app, "Create new worktree");
    expect(sandbox.ghCalls().some((c) => c.startsWith("repo clone"))).toBe(false);
  });
});

describe("caching", () => {
  test("reopening the modal shows the cached repo list without fetching it again", async () => {
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }, { nameWithOwner: "acme/gadget" }]);
    app = await renderApp();
    app.mockInput.pressKey("n");
    await waitForText(app, "2 repos");
    const repoFetches = () => sandbox.ghCalls().filter((c) => c.startsWith("api user/repos")).length;
    const fetched = repoFetches();

    app.mockInput.pressEscape();
    await waitForModalClosed(app);
    app.mockInput.pressKey("n");
    // The modal's first frame is already the list — no loading screen, no new request.
    const frame = await waitUntil(
      app,
      () => /2 repos|Loading repositories/.test(app.captureCharFrame()),
      "the modal to open",
    );
    expect(frame).toContain("2 repos");
    expect(frame).not.toContain("Loading repositories");
    expect(repoFetches()).toBe(fetched);
  });

  test("a repo list that spans several pages is loaded in the background", async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ nameWithOwner: `acme/repo-${n}-${i}` }));
    sandbox.setRepoPage(1, page(1, 100)); // a full page: there may be more
    sandbox.setRepoPage(2, page(2, 3));
    app = await renderApp();
    app.mockInput.pressKey("n");
    await waitForText(app, "103 repos");
  });
});

describe("typing", () => {
  test("a burst of keystrokes keeps every character", async () => {
    await knownProject("acme/widget");

    app = await renderApp();
    app.mockInput.pressKey("a");
    await waitForText(app, "Create new worktree");
    app.mockInput.pressEnter();
    await waitForText(app, "New branch name");

    // No delay between keys: they arrive in one tick, before React re-renders.
    for (const ch of "feature/deep/name") app.mockInput.pressKey(ch);
    await waitForText(app, "❯ feature/deep/name");
  });

  test("uppercase survives — branch names are case-sensitive", async () => {
    const root = await knownProject("acme/widget");

    app = await renderApp();
    app.mockInput.pressKey("a");
    await waitForText(app, "Create new worktree");
    app.mockInput.pressEnter();
    await waitForText(app, "New branch name");

    for (const ch of "JIRA-12") app.mockInput.pressKey(ch, { shift: /[A-Z]/.test(ch) });
    await waitForText(app, "❯ JIRA-12");
    app.mockInput.pressEnter();

    await waitForModalClosed(app);
    await waitUntil(app, () => sandbox.readState()?.repos[0]?.worktrees.length === 1, "the worktree to be registered");
    expect(sandbox.readState()!.repos[0]!.worktrees[0]!.branch).toBe("JIRA-12");
    expect(await git(["branch", "--list", "JIRA-12"], root)).toContain("JIRA-12");
  });

  test("backspace edits the branch name", async () => {
    await knownProject("acme/widget");

    app = await renderApp();
    app.mockInput.pressKey("a");
    await waitForText(app, "Create new worktree");
    app.mockInput.pressEnter();
    await waitForText(app, "New branch name");

    for (const ch of "feat") app.mockInput.pressKey(ch);
    await waitForText(app, "❯ feat");
    app.mockInput.pressBackspace();
    app.mockInput.pressBackspace();
    await waitForText(app, "❯ fe");
  });

  test("the repo filter takes uppercase too", async () => {
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/Widget" }, { nameWithOwner: "acme/gadget" }]);

    app = await renderApp();
    app.mockInput.pressKey("n");
    await waitForText(app, "2 repos");

    app.mockInput.pressKey("W", { shift: true });
    const frame = await waitForText(app, "filter W");
    expect(frame).toContain("acme/Widget");
    expect(frame).not.toContain("acme/gadget");
  });
});

describe("loading a worktree that already exists", () => {
  test("the actions list offers the main copy and adopts it into state", async () => {
    await knownProject("acme/widget", [{ branch: "feature/x" }]);
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }]);

    app = await renderApp();
    app.mockInput.pressKey("n");
    await waitForText(app, "acme/widget");
    app.mockInput.pressEnter();
    await waitForText(app, "Create new worktree");

    // Row 0 is "create new", then the main copy, then the existing worktree.
    app.mockInput.pressArrow("down");
    app.mockInput.pressArrow("down");
    const frame = await waitForText(app, "feature/x");
    expect(frame).toContain("◆ main");
    app.mockInput.pressEnter();

    await waitForModalClosed(app);
    await waitUntil(
      app,
      () => sandbox.readState()?.repos[0]?.worktrees.length === 1,
      "the existing worktree to be registered",
    );
    expect(sandbox.readState()!.repos[0]!.worktrees[0]).toMatchObject({
      branch: "feature/x",
      name: "x",
    });
  });

  test("typing a branch that already has a worktree loads it instead of failing", async () => {
    const root = await knownProject("acme/widget", [{ branch: "feature/x" }]);
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }]);

    app = await renderApp();
    app.mockInput.pressKey("n");
    await waitForText(app, "acme/widget");
    app.mockInput.pressEnter();
    await waitForText(app, "Create new worktree");
    app.mockInput.pressEnter();
    await waitForText(app, "New branch name");

    await app.mockInput.typeText("feature/x");
    app.mockInput.pressEnter();

    await waitForModalClosed(app);
    await waitUntil(
      app,
      () => sandbox.readState()?.repos[0]?.worktrees.length === 1,
      "the existing worktree to be registered",
    );
    // No second directory, and no error screen.
    expect(existsSync(join(root, ".worktrees", "feature-x"))).toBe(true);
    expect(await git(["worktree", "list"], root)).not.toContain("feature-x-1");
  });
});

describe("adding to the project under the cursor", () => {
  test("`a` preselects the repo and skips the picker; esc closes outright", async () => {
    await knownProject("acme/widget");

    app = await renderApp();
    await waitForText(app, "widget");

    app.mockInput.pressKey("a");
    await waitForText(app, "Create new worktree");
    // Preselected: the repo list was never fetched.
    expect(sandbox.ghCalls().some((c) => c.startsWith("api"))).toBe(false);

    app.mockInput.pressEscape();
    await waitForModalClosed(app);
  });
});

describe("failures", () => {
  test("a gh error explains itself and `r` retries", async () => {
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }]);
    sandbox.failGh("api");

    app = await renderApp();
    app.mockInput.pressKey("n");
    const frame = await waitForText(app, "Bad credentials");
    expect(frame).toContain("gh auth login");

    sandbox.failGh(); // the user fixes their auth
    app.mockInput.pressKey("r");
    await waitForText(app, "acme/widget");
  });

  test("a failed clone keeps the modal open and offers a retry", async () => {
    await makeRemote(sandbox, "acme/widget");
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }]);
    sandbox.failGh("clone");

    app = await renderApp();
    app.mockInput.pressKey("n");
    await waitForText(app, "acme/widget");
    app.mockInput.pressEnter();

    await waitForText(app, "repository not found");
    sandbox.failGh();
    app.mockInput.pressKey("r");
    await waitForText(app, "Create new worktree");
    expect(existsSync(join(sandbox.workspace, "widget", "README.md"))).toBe(true);
  });

  test("esc from the clone error goes back to the repo list", async () => {
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }]);
    sandbox.failGh("clone");

    app = await renderApp();
    app.mockInput.pressKey("n");
    await waitForText(app, "acme/widget");
    app.mockInput.pressEnter();
    await waitForText(app, "repository not found");

    app.mockInput.pressEscape();
    await waitForText(app, "1 repos");
  });
});
