/**
 * The PR panel on the right: shown for the worktree on screen when it has an
 * open PR, fed by a fake `gh`, toggled and resized by keys and mouse.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp } from "../helpers/app";
import { waitForSelection, waitForText, waitForTextGone, waitUntil } from "../helpers/frame";
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

const PR_URL = "https://github.com/acme/widget/pull/42";
const LINT_URL = "https://github.com/acme/widget/actions/runs/2";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const CHECKS = [
  { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
  {
    __typename: "CheckRun",
    name: "lint",
    workflowName: "CI",
    status: "COMPLETED",
    conclusion: "FAILURE",
    detailsUrl: LINT_URL,
  },
  { __typename: "CheckRun", name: "e2e", workflowName: "E2E", status: "IN_PROGRESS", conclusion: null },
];

/** One project: main + feature/login, which has PR #42. */
async function setup(opts: { prView?: boolean; branchPr?: boolean } = {}) {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/login" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  if (opts.branchPr !== false) {
    sandbox.setBranchPr(
      { number: 42, title: "Add login", headRefName: "feature/login", checks: CHECKS },
      "feature/login",
    );
  }
  if (opts.prView !== false) {
    sandbox.setPrView(42, {
      number: 42,
      title: "Add login screen with OAuth",
      url: PR_URL,
      state: "OPEN",
      isDraft: false,
      author: { login: "ignacy" },
      baseRefName: "main",
      headRefName: "feature/login",
      additions: 412,
      deletions: 37,
      changedFiles: 9,
      updatedAt: ago(14),
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      reviewDecision: "CHANGES_REQUESTED",
      latestReviews: [
        { author: { login: "alice" }, state: "APPROVED" },
        { author: { login: "bob" }, state: "CHANGES_REQUESTED" },
      ],
      reviewRequests: [{ login: "carol" }],
      comments: [{ author: { login: "alice" }, body: "Tested on staging, works.", createdAt: ago(30) }],
      labels: [{ name: "auth" }],
      statusCheckRollup: CHECKS,
      body: "Adds a login screen.",
    });
    sandbox.setPrComments(42, [
      {
        user: { login: "bob" },
        body: "Guard this with the lock.",
        created_at: ago(20),
        path: "src/session.ts",
        line: 57,
      },
    ]);
  }
}

/** Render at a comfortable size and select feature/login's row. */
async function openOnLogin(width = 140) {
  app = await renderApp({ width, height: 40 });
  await waitForText(app, "feature/login");
  app.mockInput.pressKey("j"); // main
  app.mockInput.pressKey("j"); // login
  await waitForSelection(app, "login");
}

/** Column of `text` on the first frame line containing it (single-width text before it). */
function locate(app: RenderedApp, text: string): { x: number; y: number } {
  const lines = app.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes(text));
  if (y < 0) throw new Error(`"${text}" not on screen`);
  return { x: lines[y]!.indexOf(text), y };
}

describe("showing the PR", () => {
  test("appears for a worktree with an open PR, and not for one without", async () => {
    await setup();
    await openOnLogin();
    await waitForText(app, "Add login screen with OAuth");
    app.mockInput.pressKey("k"); // back to main, which has no PR
    await waitForTextGone(app, "Add login screen with OAuth");
  });

  test("shows merge status, reviews, checks, labels, description and comments", async () => {
    await setup();
    await openOnLogin();
    const frame = await waitForText(app, "Blocked: changes requested");
    for (const text of [
      "ignacy · main ← feature/login",
      "+412 −37 · 9 files",
      "alice · approved",
      "bob · changes requested",
      "carol · review requested",
      "✗ 1  ◌ 1  ✓ 1", // checks summary
      "✗ lint · CI",
      "auth",
      "Adds a login screen.",
      "src/session.ts:57",
      "Guard this with the lock.",
      "Tested on staging, works.",
    ]) {
      expect(frame).toContain(text);
    }
    // Failing checks are listed before running and passing ones.
    expect(frame.indexOf("lint · CI")).toBeLessThan(frame.indexOf("e2e · E2E"));
    expect(frame.indexOf("e2e · E2E")).toBeLessThan(frame.indexOf("build · CI"));
  });

  test("says why when the PR can't be loaded", async () => {
    await setup({ prView: false });
    await openOnLogin();
    await waitForText(app, "Couldn't load PR #42");
  });

  test("on a 100-column screen it waits for room: selecting its worktree doesn't narrow the sidebar", async () => {
    await setup();
    app = await renderApp({ width: 100, height: 40 });
    await waitForText(app, "feature/login");
    // The right edge of the first card: where the sidebar ends.
    const edge = () => {
      const lines = app.captureCharFrame().split("\n");
      return lines.find((l) => l.includes("╮"))!.indexOf("╮");
    };
    const before = edge();
    app.mockInput.pressKey("j"); // main
    app.mockInput.pressKey("j"); // login
    await waitForSelection(app, "login");
    await waitForText(app, `${ICON.pr} #42`); // its PR is known: the panel is wanted
    expect(edge()).toBe(before);
    expect(app.captureCharFrame()).not.toContain("Blocked: changes requested");
    // Narrowing the sidebar yourself makes room for it.
    app.mockInput.pressKey("[");
    await waitForText(app, "Blocked: changes requested");
  });
});

describe("controls", () => {
  test("p hides the panel and it stays hidden; p shows it again", async () => {
    await setup();
    await openOnLogin();
    await waitForText(app, "Reviews");
    app.mockInput.pressKey("p");
    await waitForTextGone(app, "Reviews");
    await waitUntil(app, () => sandbox.readState()?.ui?.prPanelHidden === true, "hidden to be saved");
    app.mockInput.pressKey("p");
    await waitForText(app, "Reviews");
    await waitUntil(app, () => sandbox.readState()?.ui?.prPanelHidden === undefined, "shown to be saved");
  });

  test("its ✕ hides it too", async () => {
    await setup();
    await openOnLogin();
    await waitForText(app, "Reviews");
    const { x, y } = locate(app, "✕");
    await app.mockMouse.click(x, y);
    await waitForTextGone(app, "Reviews");
  });

  test("o opens the PR in the browser", async () => {
    await setup();
    await openOnLogin();
    await waitForText(app, "Reviews");
    app.mockInput.pressKey("o");
    await waitUntil(app, () => sandbox.openedUrls().includes(PR_URL), "the PR to be opened");
  });

  test("clicking a check opens its log", async () => {
    await setup();
    await openOnLogin();
    await waitForText(app, "lint · CI");
    const { x, y } = locate(app, "lint · CI");
    await app.mockMouse.click(x, y);
    await waitUntil(app, () => sandbox.openedUrls().includes(LINT_URL), "the check's log to be opened");
  });

  test("r fetches the PR again", async () => {
    await setup();
    await openOnLogin();
    await waitForText(app, "Reviews");
    const views = () => sandbox.ghCalls().filter((c) => c.startsWith("pr view 42")).length;
    const before = views();
    app.mockInput.pressKey("r");
    await waitUntil(app, () => views() > before, "another pr view");
  });

  test("r also finds a PR opened after startup", async () => {
    await setup({ branchPr: false });
    await openOnLogin();
    expect(app.captureCharFrame()).not.toContain("Reviews");
    sandbox.setBranchPr({ number: 42, title: "Add login", headRefName: "feature/login" }, "feature/login");
    app.mockInput.pressKey("r");
    await waitForText(app, "Add login screen with OAuth");
  });

  test("dragging its left edge resizes it, and the width is remembered", async () => {
    await setup();
    await openOnLogin();
    await waitForText(app, "Reviews");
    const edge = 140 - 46; // default width, flush right
    await app.mockMouse.drag(edge, 20, 80, 20);
    await waitUntil(app, () => sandbox.readState()?.ui?.prPanelWidth === 60, "the width to be saved");
    await waitUntil(
      app,
      () => (app.captureCharFrame().split("\n")[0] ?? "").lastIndexOf("│") === 80,
      "the panel's edge at column 80",
    );
  });
});

describe("folding sections", () => {
  /** Click a section's header band, folded or not. */
  async function clickHeader(title: string) {
    const folded = app.captureCharFrame().includes(`▸ ${title}`);
    const { x, y } = locate(app, `${folded ? "▸" : "▾"} ${title}`);
    await app.mockMouse.click(x + 2, y);
  }

  test("clicking a section's header folds it; its summary stays in the header", async () => {
    await setup();
    await openOnLogin();
    await waitForText(app, "✗ lint · CI");
    await clickHeader("Checks");
    const frame = await waitForText(app, "▸ Checks");
    expect(frame).toContain("✗ 1  ◌ 1  ✓ 1"); // the counts, still there
    expect(frame).not.toContain("✗ lint · CI");
    expect(frame).toContain("alice · approved"); // other sections untouched

    await clickHeader("Checks"); // and back
    await waitForText(app, "✗ lint · CI");
  });

  test("a folded Merge section shows its status in the header", async () => {
    await setup();
    await openOnLogin();
    await waitForText(app, " Merge… ");
    await clickHeader("Merge");
    const frame = await waitForText(app, "▸ Merge  Blocked: changes requested");
    expect(frame).not.toContain(" Merge… "); // the button is folded away with it
  });

  test("folded sections stay folded — for other PRs, and after a restart", async () => {
    await setup();
    await openOnLogin();
    await waitForText(app, "Adds a login screen.");
    await clickHeader("Description");
    await clickHeader("Comments");
    await waitForTextGone(app, "Adds a login screen.");
    await waitUntil(
      app,
      () => JSON.stringify(sandbox.readState()?.ui?.prPanelCollapsed) === '["description","comments"]',
      "the folded sections to be saved",
    );
    app.dispose();

    await openOnLogin();
    const frame = await waitForText(app, "▸ Description");
    expect(frame).toContain("▸ Comments");
    expect(frame).not.toContain("Guard this with the lock.");
    expect(frame).toContain("✗ lint · CI");
  });
});
