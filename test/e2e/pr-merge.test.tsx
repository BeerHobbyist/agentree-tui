/**
 * Merging the PR on screen from the PR panel: `m` (or the panel's Merge
 * button) → pick a method the repo allows → confirm → `gh pr merge`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { waitForSelection, waitForText, waitForTextGone, waitUntil } from "../helpers/frame";
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

const SHA = "0123456789abcdef0123456789abcdef01234567";
const MODAL = "Merge #42 ";

function prView(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: "Add login screen",
    url: "https://github.com/acme/widget/pull/42",
    state: "OPEN",
    isDraft: false,
    author: { login: "ignacy" },
    baseRefName: "main",
    headRefName: "feature/login",
    headRefOid: SHA,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    updatedAt: new Date().toISOString(),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    ...over,
  };
}

/** feature/login with PR #42, selected, its panel showing. */
async function start(opts: { view?: Record<string, unknown>; settings?: Record<string, unknown> } = {}) {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/login" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  sandbox.setBranchPr({ number: 42, title: "Add login screen", headRefName: "feature/login" }, "feature/login");
  sandbox.setPrView(42, prView(opts.view));
  if (opts.settings) sandbox.setRepoSettings(opts.settings);
  app = await renderApp({ width: 140, height: 40 });
  await waitForText(app, "feature/login");
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "login");
  await waitForText(app, " Merge… ");
}

const merges = () => sandbox.ghCalls().filter((c) => c.startsWith("pr merge "));

/** Where `text` first appears on screen. */
function locate(text: string): { x: number; y: number } {
  const lines = app.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes(text));
  if (y < 0) throw new Error(`"${text}" not on screen`);
  return { x: lines[y]!.indexOf(text), y };
}

describe("merging from the PR panel", () => {
  test("m → pick → confirm merges, pinned to the head commit on screen", async () => {
    await start();
    app.mockInput.pressKey("m");
    await waitForText(app, "▶ Squash and merge");
    app.mockInput.pressEnter();
    await waitForText(app, "Squash and merge #42 into main?");
    expect(merges()).toEqual([]); // not before the confirm

    app.mockInput.pressKey("y");
    await waitForText(app, "✓ Merged #42 into main.");
    expect(merges()).toEqual([`pr merge 42 -R acme/widget --squash --match-head-commit ${SHA}`]);
    app.mockInput.pressEnter();
    await waitForTextGone(app, MODAL);
  });

  test("backing out at any step merges nothing", async () => {
    await start();
    app.mockInput.pressKey("m");
    await waitForText(app, "▶ Squash and merge");
    app.mockInput.pressEnter();
    await waitForText(app, "into main?");
    app.mockInput.pressKey("n"); // back to the methods
    await waitForText(app, "▶ Squash and merge");
    app.mockInput.pressEscape(); // and out
    await waitForTextGone(app, MODAL);
    // …and the sidebar has its keys back.
    app.mockInput.pressKey("k");
    await waitForSelection(app, "main");
    expect(merges()).toEqual([]);
  });

  test("the panel's Merge button opens it too; a method can be picked with the mouse", async () => {
    await start();
    const button = locate(" Merge… ");
    await app.mockMouse.click(button.x + 2, button.y);
    await waitForText(app, "Rebase and merge");
    const rebase = locate("Rebase and merge");
    await app.mockMouse.click(rebase.x + 2, rebase.y);
    await waitForText(app, "Rebase and merge #42 into main?");
    app.mockInput.pressEnter();
    await waitUntil(app, () => merges().some((c) => c.includes("--rebase")), "the rebase merge");
  });

  test("only the methods the repo allows are offered", async () => {
    await start({ settings: { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false } });
    app.mockInput.pressKey("m");
    const frame = await waitForText(app, "▶ Create a merge commit");
    expect(frame).not.toContain("Squash and merge");
    expect(frame).not.toContain("Rebase and merge");
    app.mockInput.pressEnter();
    await waitForText(app, "Merge #42 into main with a merge commit?");
    app.mockInput.pressKey("y");
    await waitUntil(app, () => merges().some((c) => c.includes("--merge")), "the merge");
  });

  test("the method used last is offered first next time", async () => {
    await start();
    app.mockInput.pressKey("m");
    await waitForText(app, "▶ Squash and merge");
    app.mockInput.pressKey("j");
    app.mockInput.pressKey("j");
    await waitForText(app, "▶ Rebase and merge");
    app.mockInput.pressEnter();
    app.mockInput.pressKey("y");
    await waitForText(app, "✓ Merged");
    await waitUntil(app, () => sandbox.readState()?.ui?.mergeMethod === "rebase", "the method to be remembered");
    app.mockInput.pressEscape();
    await waitForTextGone(app, MODAL);

    app.mockInput.pressKey("m");
    await waitForText(app, "▶ Rebase and merge");
  });

  test("a blocked PR can be set to merge when ready, if the repo has auto-merge", async () => {
    await start({
      view: { mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" },
      settings: { allow_auto_merge: true },
    });
    app.mockInput.pressKey("m");
    await waitForText(app, "▶ Squash and merge when ready");
    app.mockInput.pressEnter();
    await waitForText(app, "Set #42 to squash-merge into main once it's ready?");
    app.mockInput.pressKey("y");
    await waitForText(app, "✓ Auto-merge on");
    expect(merges()).toEqual([`pr merge 42 -R acme/widget --squash --auto --match-head-commit ${SHA}`]);
  });

  test("a PR that can't be merged says why and offers nothing", async () => {
    await start({ view: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } });
    app.mockInput.pressKey("m");
    await waitForText(app, "Can't merge from here: Merge conflicts with main.");
    expect(app.captureCharFrame()).not.toContain("Squash and merge");
    app.mockInput.pressEnter(); // nothing to pick
    await Bun.sleep(200);
    expect(merges()).toEqual([]);
  });

  test("GitHub refusing the merge is shown, and you can go back", async () => {
    await start();
    sandbox.failGh("merge");
    app.mockInput.pressKey("m");
    await waitForText(app, "▶ Squash and merge");
    app.mockInput.pressEnter();
    app.mockInput.pressKey("y");
    await waitForText(app, "Couldn't merge: GraphQL: Pull request is not mergeable");
    app.mockInput.pressEnter();
    await waitForText(app, "▶ Squash and merge");
  });

  test("once merged, the badge goes (gh no longer lists it as open)", async () => {
    await start();
    await waitForText(app, "⇡#42");
    sandbox.setBranchPr(null, "feature/login"); // what GitHub says after the merge
    sandbox.setPrView(42, prView({ state: "MERGED" }));
    app.mockInput.pressKey("m");
    await waitForText(app, "▶ Squash and merge");
    app.mockInput.pressEnter();
    app.mockInput.pressKey("y");
    await waitForText(app, "✓ Merged #42 into main.");
    app.mockInput.pressEnter();
    await waitForTextGone(app, "⇡#42");
  });
});
