/**
 * PR details are cached (TanStack Query): moving between worktrees shows what
 * was already loaded instead of asking GitHub again.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createQueryClient } from "../../src/queryClient";
import { loadState, reconcile, saveState, upsertRepo } from "../../src/store";
import { renderApp, type RenderedApp, type RenderAppOptions } from "../helpers/app";
import { settle, waitForSelection, waitForText, waitUntil } from "../helpers/frame";
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

function prView(number: number, title: string, head: string) {
  return {
    number,
    title,
    url: `https://github.com/acme/widget/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    author: { login: "ignacy" },
    baseRefName: "main",
    headRefName: head,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    updatedAt: new Date().toISOString(),
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
  };
}

const PASSING = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];

/** main + feature/login (PR #42) + feature/billing (PR #43). */
async function start(opts: RenderAppOptions = {}) {
  const root = await makeRepo(join(sandbox.workspace, "widget"), {
    worktrees: [{ branch: "feature/login" }, { branch: "feature/billing" }],
  });
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  await reconcile(state);
  sandbox.setBranchPr({ number: 42, title: "Login", headRefName: "feature/login", checks: PASSING }, "feature/login");
  sandbox.setBranchPr({ number: 43, title: "Billing", headRefName: "feature/billing" }, "feature/billing");
  sandbox.setPrView(42, prView(42, "Add login screen", "feature/login"));
  sandbox.setPrView(43, prView(43, "Add billing page", "feature/billing"));
  app = await renderApp({ width: 140, height: 40, ...opts });
  await waitForText(app, "feature/login");
}

/** Select a worktree row: find its place in the sidebar, then g + that many j. */
async function select(name: "main" | "login" | "billing") {
  const sidebar = app
    .captureCharFrame()
    .split("\n")
    .map((l) => l.slice(0, 38));
  const row = (n: string) => sidebar.findIndex((l) => l.includes(`${ICON.noAgent} ${n}`));
  const order = (["main", "login", "billing"] as const).slice().sort((a, b) => row(a) - row(b));
  app.mockInput.pressKey("g"); // the project header
  for (let i = 0; i <= order.indexOf(name); i++) app.mockInput.pressKey("j");
  await waitForSelection(app, name);
}

const views = (n: number) => sandbox.ghCalls().filter((c) => c.startsWith(`pr view ${n} `)).length;

describe("PR details cache", () => {
  test("coming back to a PR shows it from cache, without asking GitHub again", async () => {
    await start();
    await select("login");
    await waitForText(app, "Add login screen");
    const fetched = views(42);

    await select("main"); // no PR — the panel goes away
    await select("login");
    await settle(app);
    // On screen from the first frame: no "Loading…", no new request.
    expect(app.captureCharFrame()).toContain("Add login screen");
    expect(app.captureCharFrame()).not.toContain("Loading PR");
    expect(views(42)).toBe(fetched);
  });

  test("switching back and forth between two PRs fetches each once", async () => {
    await start();
    await select("login");
    await waitForText(app, "Add login screen");
    await select("billing");
    await waitForText(app, "Add billing page");
    const before = [views(42), views(43)];

    for (let i = 0; i < 3; i++) {
      await select("login");
      await waitForText(app, "Add login screen");
      await select("billing");
      await waitForText(app, "Add billing page");
    }
    expect([views(42), views(43)]).toEqual(before);
  });

  test("once stale, the cached PR still shows at once and refreshes in the background", async () => {
    await start({ queryClient: createQueryClient({ staleTime: 200 }) });
    await select("login");
    await waitForText(app, "Add login screen");
    const fetched = views(42);

    await select("main");
    await Bun.sleep(400); // past the stale time
    sandbox.setPrView(42, prView(42, "Add login screen (v2)", "feature/login"));
    await select("login");
    await settle(app);
    expect(app.captureCharFrame()).toContain("Add login screen"); // the cached copy, immediately
    await waitForText(app, "Add login screen (v2)"); // then the refreshed one
    expect(views(42)).toBe(fetched + 1);
  });

  test("a failed refresh keeps showing the last good data", async () => {
    await start();
    await select("login");
    await waitForText(app, "Add login screen");
    sandbox.failGh("pr");
    app.mockInput.pressKey("r");
    await waitForText(app, "refresh failed", { timeoutMs: 10_000 }); // after its one retry
    expect(app.captureCharFrame()).toContain("Add login screen");
    // …and the sidebar badge, whose lookup failed too, keeps its last answer.
    expect(app.captureCharFrame()).toContain(`${ICON.pr} #42`);
  }, 20_000);

  test("a PR whose checks changed is fetched again when you come back to it", async () => {
    await start();
    await select("login");
    await waitForText(app, "Add login screen");
    const fetched = views(42);

    await select("main");
    // CI failed on #42 meanwhile; the sidebar's PR lookup (r) notices…
    sandbox.setBranchPr(
      {
        number: 42,
        title: "Login",
        headRefName: "feature/login",
        checks: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }],
      },
      "feature/login",
    );
    sandbox.setPrView(42, prView(42, "Add login screen (CI red)", "feature/login"));
    app.mockInput.pressKey("r");
    await waitUntil(
      app,
      () => sandbox.ghCalls().filter((c) => c.includes("--head feature/login")).length >= 2,
      "the PR lookup to run again",
    );
    await settle(app);

    // …so #42's cached details are stale and get refetched, well inside the 30s stale time.
    await select("login");
    await waitForText(app, "Add login screen (CI red)");
    expect(views(42)).toBe(fetched + 1);
  });
});
