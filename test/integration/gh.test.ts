/**
 * `services/gh` against a fake `gh` on PATH — the CLI's argv, its JSON, its
 * failures and the module-level caches, without touching the network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  clone,
  fetchRepoPage,
  isAuthenticated,
  prForBranch,
} from "../../src/services/gh";
import { fetchMergeSettings, fetchPrDetails, mergePr } from "../../src/services/pr";
import { createSandbox, repoSummary, type Sandbox } from "../helpers/sandbox";
import { makeRemote } from "../helpers/repo";

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

describe("fetchRepoPage", () => {
  test("maps the REST fields the UI needs", async () => {
    sandbox.setRepoPage(1, [
      { nameWithOwner: "acme/widget", description: "a widget", isPrivate: true, pushedAt: "2026-02-03T00:00:00Z" },
    ]);
    const page = await fetchRepoPage(1);
    expect(page.repos[0]).toEqual({
      name: "widget",
      nameWithOwner: "acme/widget",
      description: "a widget",
      isPrivate: true,
      updatedAt: "2026-02-03T00:00:00Z",
      url: "https://github.com/acme/widget",
    });
  });

  test("asks for collaborator and org repos, not just the user's own", async () => {
    sandbox.setRepoPage(1, []);
    await fetchRepoPage(1);
    const call = sandbox.ghCalls().at(-1)!;
    expect(call).toContain("user/repos");
    expect(call).toContain("affiliation=owner,collaborator,organization_member");
    expect(call).toContain("sort=pushed");
    expect(call).toContain("page=1");
  });

  test("a short page means there is nothing more to fetch", async () => {
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/widget" }]);
    expect((await fetchRepoPage(1)).hasMore).toBe(false);
  });

  test("a full page means another one probably exists", async () => {
    sandbox.setRepoPage(1, Array.from({ length: 100 }, (_, i) => ({ nameWithOwner: `acme/r${i}` })));
    const page = await fetchRepoPage(1);
    expect(page.repos).toHaveLength(100);
    expect(page.hasMore).toBe(true);
  });

  test("pages are served independently", async () => {
    sandbox.setRepoPage(1, [{ nameWithOwner: "acme/one" }]);
    sandbox.setRepoPage(2, [{ nameWithOwner: "acme/two" }]);
    expect((await fetchRepoPage(2)).repos[0]!.name).toBe("two");
  });

  test("propagates gh's stderr so the modal can show it", async () => {
    sandbox.failGh("api");
    expect(fetchRepoPage(1)).rejects.toThrow(/Bad credentials/);
  });
});

describe("prForBranch", () => {
  test("returns the open PR for a branch", async () => {
    await Bun.write(
      join(process.env.FAKE_GH_DIR!, "prs.json"),
      JSON.stringify([{ number: 42, title: "Add tests", url: "https://gh/42", isDraft: true }]),
    );
    expect(await prForBranch("acme/widget", "feature/x")).toEqual({
      number: 42,
      title: "Add tests",
      url: "https://gh/42",
      draft: true,
    });
  });

  test("queries the branch as head, open only", async () => {
    await prForBranch("acme/widget", "feature/x");
    const call = sandbox.ghCalls().at(-1)!;
    expect(call).toContain("pr list -R acme/widget --head feature/x --state open");
  });

  test("no PR is a null, not an error", async () => {
    expect(await prForBranch("acme/widget", "feature/x")).toBeNull();
  });

  test("summarises the PR's checks for the badge", async () => {
    sandbox.setBranchPr({
      number: 7,
      title: "t",
      headRefName: "feature/x",
      checks: [
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
      ],
    });
    expect((await prForBranch("acme/widget", "feature/x"))?.checks).toBe("fail");
    expect(sandbox.ghCalls().at(-1)).toContain("statusCheckRollup");
  });

  test("a branch-specific PR is only found for that branch", async () => {
    sandbox.setBranchPr({ number: 7, title: "t", headRefName: "feature/x" }, "feature/x");
    expect((await prForBranch("acme/widget", "feature/x"))?.number).toBe(7);
    expect(await prForBranch("acme/widget", "feature/y")).toBeNull();
  });

  test("a failing gh is an error, not \"no PR\" — so a cache keeps the last good badge", async () => {
    sandbox.failGh("pr");
    await expect(prForBranch("acme/widget", "feature/x")).rejects.toThrow("pr failed");
  });
});

describe("isAuthenticated", () => {
  test("true when gh auth status succeeds", async () => {
    expect(await isAuthenticated()).toBe(true);
  });

  test("false when it does not", async () => {
    sandbox.failGh("auth");
    expect(await isAuthenticated()).toBe(false);
  });
});

describe("clone", () => {
  test("clones into the requested directory", async () => {
    await makeRemote(sandbox, "acme/widget");
    const dest = join(sandbox.workspace, "widget");
    await clone("acme/widget", dest);
    expect(existsSync(join(dest, "README.md"))).toBe(true);
  });

  test("throws with gh's message when the clone fails", async () => {
    sandbox.failGh("clone");
    expect(clone("acme/widget", join(sandbox.workspace, "widget"))).rejects.toThrow(
      /repository not found/,
    );
  });
});

describe("fetchPrDetails", () => {
  const view = {
    number: 42,
    title: "Add login",
    url: "https://github.com/acme/widget/pull/42",
    state: "OPEN",
    isDraft: false,
    author: { login: "ignacy" },
    baseRefName: "main",
    headRefName: "feature/login",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    updatedAt: "2026-09-23T10:00:00Z",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    latestReviews: [{ author: { login: "alice" }, state: "APPROVED" }],
    comments: [{ author: { login: "alice" }, body: "LGTM", createdAt: "2026-09-23T09:00:00Z" }],
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    labels: [{ name: "feature" }],
    body: "Adds login.",
  };

  test("combines gh pr view with the PR's inline review comments", async () => {
    sandbox.setPrView(42, view);
    sandbox.setPrComments(42, [
      { user: { login: "bob" }, body: "nit", created_at: "2026-09-23T09:30:00Z", path: "src/a.ts", line: 3 },
    ]);
    const d = await fetchPrDetails("acme/widget", 42);
    expect(d).toMatchObject({ number: 42, state: "open", author: "ignacy", reviewDecision: "approved" });
    expect(d.checks).toEqual([{ name: "ci", state: "pass" }]);
    expect(d.comments.map((c) => `${c.kind}:${c.author}`)).toEqual(["inline:bob", "comment:alice"]);

    const calls = sandbox.ghCalls();
    expect(calls.some((c) => c.startsWith("pr view 42 -R acme/widget --json"))).toBe(true);
    expect(calls.some((c) => c.startsWith("api repos/acme/widget/pulls/42/comments"))).toBe(true);
  });

  test("still loads the PR when the inline comments can't be fetched", async () => {
    sandbox.setPrView(42, view);
    sandbox.failGh("api");
    const d = await fetchPrDetails("acme/widget", 42);
    expect(d.comments.map((c) => c.kind)).toEqual(["comment"]);
  });

  test("a PR that can't be loaded is an error with gh's message", async () => {
    await expect(fetchPrDetails("acme/widget", 99)).rejects.toThrow("no pull requests found for #99");
  });
});

describe("mergePr", () => {
  test("merges with the chosen method, pinned to the head commit it was shown", async () => {
    await mergePr("acme/widget", 42, "squash", { headSha: "abc123" });
    expect(sandbox.ghCalls()).toContain("pr merge 42 -R acme/widget --squash --match-head-commit abc123");
  });

  test("auto-merge adds --auto; no head commit known → not pinned", async () => {
    const message = await mergePr("acme/widget", 7, "rebase", { auto: true });
    expect(sandbox.ghCalls()).toContain("pr merge 7 -R acme/widget --rebase --auto");
    expect(message).toContain("automatically merged");
  });

  test("never deletes branches (the worktree still has it checked out)", async () => {
    await mergePr("acme/widget", 42, "merge");
    expect(sandbox.ghCalls().join("\n")).not.toContain("--delete-branch");
  });

  test("a refusal from GitHub is an error with gh's message", async () => {
    sandbox.failGh("merge");
    await expect(mergePr("acme/widget", 42, "squash")).rejects.toThrow("not mergeable");
  });
});

describe("fetchMergeSettings", () => {
  test("reads the repo's allowed methods and auto-merge", async () => {
    sandbox.setRepoSettings({ allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: false, allow_auto_merge: true });
    expect(await fetchMergeSettings("acme/widget")).toEqual({ methods: ["squash"], autoMerge: true });
    expect(sandbox.ghCalls()).toContain("api repos/acme/widget");
  });

  test("a failed lookup is an error, not \"everything allowed\"", async () => {
    sandbox.failGh("api");
    await expect(fetchMergeSettings("acme/widget")).rejects.toThrow();
  });
});
