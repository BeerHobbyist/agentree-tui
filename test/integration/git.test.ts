/** `services/git` against real repositories created in a temp sandbox. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addWorktree,
  baseRef,
  ignoreWorktreesDir,
  listWorktrees,
  localBranchExists,
  removeWorktree,
  status,
} from "../../src/services/git";
import { createSandbox, type Sandbox } from "../helpers/sandbox";
import { commitAll, git, makeRepo, withUpstream, writeFile } from "../helpers/repo";

let sandbox: Sandbox;
let repo: string;

beforeEach(async () => {
  sandbox = createSandbox();
  repo = await makeRepo(join(sandbox.workspace, "widget"));
});
afterEach(() => sandbox.cleanup());

describe("listWorktrees", () => {
  test("reports the main working copy first", async () => {
    const list = await listWorktrees(repo);
    expect(list).toHaveLength(1);
    expect(list[0]!.branch).toBe("main");
    expect(list[0]!.detached).toBe(false);
  });

  test("includes added worktrees with their branches", async () => {
    await addWorktree(repo, join(repo, ".worktrees", "feat-x"), "feature/x", { newBranch: true });
    const list = await listWorktrees(repo);
    expect(list.map((w) => w.branch)).toEqual(["main", "feature/x"]);
    expect(list[1]!.head).toMatch(/^[0-9a-f]{40}$/);
  });

  test("marks a detached worktree instead of inventing a branch", async () => {
    const head = (await git(["rev-parse", "HEAD"], repo)).trim();
    await git(["worktree", "add", "--detach", join(repo, ".worktrees", "det"), head], repo);
    const detached = (await listWorktrees(repo)).find((w) => w.path.endsWith("det"))!;
    expect(detached.detached).toBe(true);
    expect(detached.branch).toBeUndefined();
  });

  test("throws for a directory that is not a repo", async () => {
    expect(listWorktrees(sandbox.workspace)).rejects.toThrow();
  });
});

describe("addWorktree", () => {
  test("creates the branch when asked", async () => {
    const path = join(repo, ".worktrees", "feat-x");
    await addWorktree(repo, path, "feature/x", { newBranch: true });
    expect(existsSync(join(path, "README.md"))).toBe(true);
    expect(await localBranchExists(repo, "feature/x")).toBe(true);
  });

  test("checks out an existing branch without -b", async () => {
    await git(["branch", "existing"], repo);
    const path = join(repo, ".worktrees", "existing");
    await addWorktree(repo, path, "existing", { newBranch: false });
    expect((await listWorktrees(repo)).map((w) => w.branch)).toContain("existing");
  });

  test("fails loudly when the branch is already checked out", async () => {
    const path = join(repo, ".worktrees", "dup");
    await addWorktree(repo, path, "dup", { newBranch: true });
    expect(
      addWorktree(repo, join(repo, ".worktrees", "dup2"), "dup", { newBranch: false }),
    ).rejects.toThrow();
  });
});

describe("removeWorktree", () => {
  test("deletes the directory and git's bookkeeping for it", async () => {
    const path = join(repo, ".worktrees", "feat-x");
    await addWorktree(repo, path, "feature/x", { newBranch: true });
    await removeWorktree(repo, path);
    expect(existsSync(path)).toBe(false);
    expect((await listWorktrees(repo)).map((w) => w.branch)).toEqual(["main"]);
  });

  test("refuses to drop uncommitted changes unless forced", async () => {
    const path = join(repo, ".worktrees", "feat-x");
    await addWorktree(repo, path, "feature/x", { newBranch: true });
    writeFile(path, "scratch.txt", "x\n");

    expect(removeWorktree(repo, path)).rejects.toThrow();
    expect(existsSync(path)).toBe(true);

    await removeWorktree(repo, path, { force: true });
    expect(existsSync(path)).toBe(false);
  });
});

describe("localBranchExists", () => {
  test("is true only for an exact match", async () => {
    await git(["branch", "feature/x"], repo);
    expect(await localBranchExists(repo, "feature/x")).toBe(true);
    expect(await localBranchExists(repo, "feature")).toBe(false);
    expect(await localBranchExists(repo, "nope")).toBe(false);
  });
});

describe("baseRef", () => {
  test("prefers the remote's default branch", async () => {
    await withUpstream(repo);
    await git(["remote", "set-head", "origin", "main"], repo);
    expect(await baseRef(repo)).toBe("origin/main");
  });

  test("falls back to a local branch when there is no remote", async () => {
    expect(await baseRef(repo)).toBe("main");
  });
});

describe("status", () => {
  test("is clean for an untouched worktree", async () => {
    expect(await status(repo)).toEqual({
      dirty: false,
      changed: 0,
      added: 0,
      removed: 0,
      ahead: 0,
      behind: 0,
    });
  });

  test("counts added and removed lines against HEAD", async () => {
    writeFile(repo, "counted.txt", "a\nb\nc\n");
    await commitAll(repo, "three lines");
    writeFileSync(join(repo, "counted.txt"), "a\nB\nc\nd\n");
    const st = await status(repo);
    expect(st.dirty).toBe(true);
    expect(st.added).toBe(2); // the edited line plus the new one
    expect(st.removed).toBe(1);
  });

  test("sees an untracked file as dirty", async () => {
    writeFile(repo, "scratch.txt", "x\n");
    expect((await status(repo)).dirty).toBe(true);
  });

  test("counts changed files, untracked included", async () => {
    writeFile(repo, "counted.txt", "a\n");
    await commitAll(repo, "one");
    writeFileSync(join(repo, "counted.txt"), "b\n"); // modified
    writeFile(repo, "new-1.txt", "x\n"); // untracked
    writeFile(repo, "new-2.txt", "y\n"); // untracked
    expect((await status(repo)).changed).toBe(3);
  });

  test("reports ahead and behind against the upstream", async () => {
    await withUpstream(repo, { ahead: 2, behind: 1 });
    const st = await status(repo);
    expect(st.ahead).toBe(2);
    expect(st.behind).toBe(1);
  });

  test("degrades to zeros instead of throwing outside a repo", async () => {
    expect(await status(sandbox.workspace)).toEqual({
      dirty: false,
      changed: 0,
      added: 0,
      removed: 0,
      ahead: 0,
      behind: 0,
    });
  });
});

describe("ignoreWorktreesDir", () => {
  const excludeOf = (root: string) => join(root, ".git", "info", "exclude");

  test("excludes .worktrees/ locally, not via the tracked .gitignore", () => {
    ignoreWorktreesDir(repo);
    expect(readFileSync(excludeOf(repo), "utf8")).toContain(".worktrees/");
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });

  test("is idempotent", () => {
    ignoreWorktreesDir(repo);
    ignoreWorktreesDir(repo);
    ignoreWorktreesDir(repo);
    const lines = readFileSync(excludeOf(repo), "utf8")
      .split("\n")
      .filter((l) => l.trim() === ".worktrees/");
    expect(lines).toHaveLength(1);
  });

  test("does not glue itself onto a file with no trailing newline", () => {
    writeFileSync(excludeOf(repo), "*.log");
    ignoreWorktreesDir(repo);
    expect(readFileSync(excludeOf(repo), "utf8")).toBe("*.log\n.worktrees/\n");
  });

  test("keeps the main copy clean once a worktree lives inside it", async () => {
    ignoreWorktreesDir(repo);
    await addWorktree(repo, join(repo, ".worktrees", "feat-x"), "feature/x", { newBranch: true });
    expect((await status(repo)).dirty).toBe(false);
  });

  test("survives a missing .git layout", () => {
    expect(() => ignoreWorktreesDir(join(sandbox.root, "nope"))).not.toThrow();
  });
});
