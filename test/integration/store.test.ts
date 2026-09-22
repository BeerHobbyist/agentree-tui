/** The persisted store, and `reconcile()` against real `git worktree list`. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addManagedWorktree,
  findRepo,
  loadState,
  reconcile,
  saveState,
  upsertRepo,
  type State,
} from "../../src/store";
import { createSandbox, type Sandbox } from "../helpers/sandbox";
import { git, makeRepo } from "../helpers/repo";

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

function meta(root: string) {
  return { nameWithOwner: "acme/widget", name: "widget", root };
}

async function fixtureRepo(worktrees: { branch: string }[] = []) {
  return makeRepo(join(sandbox.workspace, "widget"), { worktrees });
}

describe("loadState", () => {
  test("returns an empty state when nothing is persisted yet", () => {
    const state = loadState();
    expect(state.repos).toEqual([]);
    expect(state.workspaceRoot).toBe(sandbox.workspace);
  });

  test("survives a corrupt state file rather than crashing at startup", () => {
    mkdirSync(join(sandbox.configHome, "agentree"), { recursive: true });
    writeFileSync(sandbox.stateFile, "{not json");
    expect(loadState().repos).toEqual([]);
  });

  test("survives a structurally wrong state file", () => {
    mkdirSync(join(sandbox.configHome, "agentree"), { recursive: true });
    writeFileSync(sandbox.stateFile, JSON.stringify({ version: 1, repos: "nope" }));
    expect(loadState().repos).toEqual([]);
  });

  test("reads back what was saved", async () => {
    const state = loadState();
    upsertRepo(state, meta("/tmp/widget"));
    await saveState(state);
    expect(loadState().repos.map((r) => r.nameWithOwner)).toEqual(["acme/widget"]);
  });
});

describe("saveState", () => {
  test("writes atomically, leaving no temp file behind", async () => {
    const state = loadState();
    upsertRepo(state, meta("/tmp/widget"));
    await saveState(state);
    const dir = join(sandbox.configHome, "agentree");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  test("creates the config directory on first save", async () => {
    expect(existsSync(sandbox.stateFile)).toBe(false);
    await saveState(loadState());
    expect(existsSync(sandbox.stateFile)).toBe(true);
  });
});

describe("upsertRepo / addManagedWorktree", () => {
  test("upsert adds once and then updates in place", () => {
    const state = loadState();
    upsertRepo(state, meta("/tmp/a"));
    upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget2", root: "/tmp/b" });
    expect(state.repos).toHaveLength(1);
    expect(findRepo(state, "acme/widget")).toMatchObject({ name: "widget2", root: "/tmp/b" });
  });

  test("upsert keeps a known default branch when the update omits it", () => {
    const state = loadState();
    upsertRepo(state, { ...meta("/tmp/a"), defaultBranch: "main" });
    upsertRepo(state, meta("/tmp/a"));
    expect(findRepo(state, "acme/widget")!.defaultBranch).toBe("main");
  });

  test("registering the same worktree twice does not duplicate it", async () => {
    const state = loadState();
    const wt = {
      id: "feat-x",
      branch: "feature/x",
      name: "x",
      path: "/tmp/widget/.worktrees/feat-x",
      createdAt: "2026-01-01T00:00:00Z",
    };
    await addManagedWorktree(state, meta("/tmp/widget"), wt);
    await addManagedWorktree(state, meta("/tmp/widget"), wt);
    expect(findRepo(state, "acme/widget")!.worktrees).toHaveLength(1);
    expect(sandbox.readState()!.repos[0]!.worktrees).toHaveLength(1);
  });
});

describe("reconcile", () => {
  test("surfaces the main working copy even though it is never stored", async () => {
    const root = await fixtureRepo();
    const state = loadState();
    upsertRepo(state, meta(root));

    const projects = await reconcile(state);
    expect(projects[0]!.worktrees).toHaveLength(1);
    expect(projects[0]!.worktrees[0]).toMatchObject({ id: "main", branch: "main", path: root });
  });

  test("adopts an on-disk worktree that state does not know about, and persists it", async () => {
    const root = await fixtureRepo([{ branch: "feature/x" }]);
    const state = loadState();
    upsertRepo(state, meta(root));

    const projects = await reconcile(state);
    expect(projects[0]!.worktrees.map((w) => w.name).sort()).toEqual(["main", "x"]);
    expect(sandbox.readState()!.repos[0]!.worktrees.map((w) => w.branch)).toEqual(["feature/x"]);
  });

  test("marks a stored worktree missing once its directory is gone", async () => {
    const root = await fixtureRepo([{ branch: "feature/x" }]);
    const state = loadState();
    upsertRepo(state, meta(root));
    await reconcile(state); // adopt it
    rmSync(join(root, ".worktrees", "feature-x"), { recursive: true, force: true });

    const projects = await reconcile(state);
    const x = projects[0]!.worktrees.find((w) => w.name === "x")!;
    expect(x.missing).toBe(true);
  });

  test("marks everything missing when the clone itself is gone", async () => {
    const state = loadState();
    await addManagedWorktree(state, meta(join(sandbox.workspace, "vanished")), {
      id: "feat-x",
      branch: "feature/x",
      name: "x",
      path: join(sandbox.workspace, "vanished", ".worktrees", "feat-x"),
      createdAt: "",
    });

    const projects = await reconcile(state);
    expect(projects[0]!.worktrees.every((w) => w.missing)).toBe(true);
  });

  test("keeps going when git cannot list worktrees", async () => {
    const root = join(sandbox.workspace, "not-a-repo");
    mkdirSync(root, { recursive: true });
    const state = loadState();
    upsertRepo(state, meta(root));

    const projects = await reconcile(state);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.worktrees).toEqual([]);
  });

  test("gives adopted worktrees distinct ids when their directories collide", async () => {
    const root = await fixtureRepo();
    // Two branches whose worktree directories are both named "x".
    await git(["worktree", "add", join(root, "a", "x"), "-b", "one"], root);
    await git(["worktree", "add", join(root, "b", "x"), "-b", "two"], root);
    const state = loadState();
    upsertRepo(state, meta(root));

    const projects = await reconcile(state);
    const ids = projects[0]!.worktrees.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("names a detached worktree rather than leaving it blank", async () => {
    const root = await fixtureRepo();
    const head = (await git(["rev-parse", "HEAD"], root)).trim();
    await git(["worktree", "add", "--detach", join(root, ".worktrees", "det"), head], root);
    const state = loadState();
    upsertRepo(state, meta(root));

    const projects = await reconcile(state);
    const det = projects[0]!.worktrees.find((w) => w.path.endsWith("det"))!;
    expect(det).toMatchObject({ name: "detached", branch: "(detached)" });
  });

  test("does not rewrite state.json when nothing changed", async () => {
    const root = await fixtureRepo();
    const state = loadState();
    upsertRepo(state, meta(root));
    await saveState(state);
    const before = Bun.file(sandbox.stateFile).lastModified;

    await Bun.sleep(10);
    await reconcile(state);
    expect(Bun.file(sandbox.stateFile).lastModified).toBe(before);
  });

  test("leaves volatile status at its defaults — it is computed at runtime", async () => {
    const root = await fixtureRepo([{ branch: "feature/x" }]);
    const state = loadState();
    upsertRepo(state, meta(root));

    const projects = await reconcile(state);
    for (const w of projects[0]!.worktrees) {
      expect(w).toMatchObject({ dirty: false, added: 0, removed: 0, ahead: 0, behind: 0, agent: "none" });
    }
    const persisted = sandbox.readState() as State;
    expect(JSON.stringify(persisted)).not.toContain("dirty");
  });
});
