/**
 * A merged PR stays on its worktree — `✓#42` in the sidebar, "Merged"
 * in the panel — until the worktree is closed, and closing it is one key away:
 * `d` in the sidebar, the panel's Close button, or `d` right after merging.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { waitForSelection, waitForText, waitForTextGone, waitUntil } from "../helpers/frame";
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

const WORKTREE = join("widget", ".worktrees", "feature-login");

function prView(state: "OPEN" | "MERGED") {
  return {
    number: 42,
    title: "Add login screen",
    url: "https://github.com/acme/widget/pull/42",
    state,
    isDraft: false,
    author: { login: "ignacy" },
    baseRefName: "main",
    headRefName: "feature/login",
    headRefOid: "0123456789abcdef0123456789abcdef01234567",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    updatedAt: new Date().toISOString(),
    mergeable: state === "OPEN" ? "MERGEABLE" : "UNKNOWN",
    mergeStateStatus: state === "OPEN" ? "CLEAN" : "UNKNOWN",
  };
}

/** GitHub's answer for feature/login: PR #42, open or merged from this worktree's commit. */
async function branchPr(state: "OPEN" | "MERGED") {
  const head = (await git(["rev-parse", "HEAD"], join(sandbox.workspace, WORKTREE))).trim();
  sandbox.setBranchPr(
    {
      number: 42,
      title: "Add login screen",
      headRefName: "feature/login",
      state,
      headRefOid: head,
      mergeCommit: "0".repeat(40),
    },
    "feature/login",
  );
  sandbox.setPrView(42, prView(state));
}

/** feature/login with PR #42 (`state`), selected, its panel showing. */
async function start(state: "OPEN" | "MERGED") {
  const root = await makeRepo(join(sandbox.workspace, "widget"), { worktrees: [{ branch: "feature/login" }] });
  const s = loadState();
  upsertRepo(s, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(s);
  await reconcile(s);
  await branchPr(state);
  app = await renderApp({ width: 140, height: 40 });
  await waitForText(app, "· login");
  app.mockInput.pressKey("j");
  app.mockInput.pressKey("j");
  await waitForSelection(app, "login");
}

/** Where `text` first appears on screen. */
function locate(text: string): { x: number; y: number } {
  const lines = app.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes(text));
  if (y < 0) throw new Error(`"${text}" not on screen`);
  return { x: lines[y]!.indexOf(text), y };
}

/** The Close button's line, from the button on. */
function closeButtonLine(): string {
  const { x, y } = locate(" Close worktree… ");
  return app.captureCharFrame().split("\n")[y]!.slice(x);
}

async function expectClosed() {
  await waitForTextGone(app, "Close worktree");
  await waitForTextGone(app, "· login");
  expect(existsSync(join(sandbox.workspace, WORKTREE))).toBe(false);
  await waitUntil(app, () => sandbox.readState()?.repos[0]?.worktrees.length === 0, "the worktree to leave state");
}

describe("a merged PR", () => {
  test("stays on its worktree, marked merged; the panel says so and offers to close it", async () => {
    await start("MERGED");
    await waitForText(app, "✓#42");
    await waitForText(app, " Close worktree… ");
    const frame = app.captureCharFrame();
    expect(frame).toContain("Merged");
    expect(frame).not.toContain(" Merge… "); // nothing left to merge
    expect(closeButtonLine()).toStartWith(" Close worktree…  d");
  });

  test("d closes the worktree (asking first)", async () => {
    await start("MERGED");
    await waitForText(app, "✓#42");
    app.mockInput.pressKey("d");
    await waitForText(app, 'Delete "login" from disk?');
    app.mockInput.pressKey("y");
    await expectClosed();
  });

  test("the panel's Close button asks too; n keeps it", async () => {
    await start("MERGED");
    await waitForText(app, " Close worktree… ");
    const at = locate(" Close worktree… ");
    await app.mockMouse.click(at.x + 2, at.y);
    await waitForText(app, 'Delete "login" from disk?');
    app.mockInput.pressKey("n");
    await waitForTextGone(app, 'Delete "login"');
    expect(existsSync(join(sandbox.workspace, WORKTREE))).toBe(true);
  });

  test("m does nothing on it", async () => {
    await start("MERGED");
    await waitForText(app, " Close worktree… ");
    app.mockInput.pressKey("m");
    await Bun.sleep(200);
    expect(app.captureCharFrame()).not.toContain("Merge #42 ");
  });

  test("the panel shows d only while its worktree is the one selected (d closes the selected row)", async () => {
    await start("MERGED");
    await waitForText(app, " Close worktree… ");
    app.mockInput.pressEnter(); // its terminal: the panel now follows that
    await waitForText(app, "^g");
    app.mockInput.pressKey("g", { ctrl: true });
    app.mockInput.pressKey("k"); // select main; login's terminal (and PR) stay on screen
    await waitForSelection(app, "main");
    await waitUntil(app, () => !closeButtonLine().startsWith(" Close worktree…  d"), "the d hint to go");
    expect(app.captureCharFrame()).toContain("✓#42");
  });
});

describe("right after merging it with m", () => {
  test("d closes the worktree — the badge has turned to merged", async () => {
    await start("OPEN");
    await waitForText(app, " Merge… ");
    app.mockInput.pressKey("m");
    await waitForText(app, "▶ Squash and merge");
    app.mockInput.pressEnter();
    await waitForText(app, "into main?");
    await branchPr("MERGED"); // what GitHub says once it's merged
    app.mockInput.pressKey("y");
    await waitForText(app, "✓ Merged #42 into main.");
    await waitForText(app, "d close the worktree");
    await waitForText(app, "✓#42");
    await waitUntil(app, () => !!sandbox.readState()?.ui?.mergeMethod, "the merge method to be saved");

    app.mockInput.pressKey("d");
    await waitForText(app, 'Delete "login" from disk?');
    app.mockInput.pressKey("y");
    await expectClosed();
  });
});
