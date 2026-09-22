/**
 * `services/gh` against a fake `gh` on PATH — the CLI's argv, its JSON, its
 * failures and the module-level caches, without touching the network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  clearPrCache,
  clearRepoCache,
  clone,
  fetchRepoPage,
  getCachedRepos,
  isAuthenticated,
  prForBranch,
  setRepoCache,
} from "../../src/services/gh";
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

describe("repo cache", () => {
  test("starts empty, round-trips, and clears", () => {
    expect(getCachedRepos()).toBeNull();
    setRepoCache([repoSummary("acme/widget")]);
    expect(getCachedRepos()).toHaveLength(1);
    clearRepoCache();
    expect(getCachedRepos()).toBeNull();
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

  test("caches per repo and branch, including the misses", async () => {
    await prForBranch("acme/widget", "feature/x");
    await prForBranch("acme/widget", "feature/x");
    expect(sandbox.ghCalls().filter((c) => c.startsWith("pr list"))).toHaveLength(1);

    await prForBranch("acme/widget", "feature/y");
    expect(sandbox.ghCalls().filter((c) => c.startsWith("pr list"))).toHaveLength(2);
  });

  test("force refetches", async () => {
    await prForBranch("acme/widget", "feature/x");
    await prForBranch("acme/widget", "feature/x", true);
    expect(sandbox.ghCalls().filter((c) => c.startsWith("pr list"))).toHaveLength(2);
  });

  test("clearPrCache makes the next lookup hit gh again", async () => {
    await prForBranch("acme/widget", "feature/x");
    clearPrCache();
    await prForBranch("acme/widget", "feature/x");
    expect(sandbox.ghCalls().filter((c) => c.startsWith("pr list"))).toHaveLength(2);
  });

  test("a failing gh degrades to no badge", async () => {
    sandbox.failGh("pr");
    expect(await prForBranch("acme/widget", "feature/x")).toBeNull();
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
