/** The persisted store, and `reconcile()` against real `git worktree list`. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addManagedWorktree,
  findRepo,
  loadState,
  reconcile,
  MAX_LABEL_LENGTH,
  addRemoteDir,
  findHost,
  normalizeLabel,
  removeHost,
  removeRemoteDir,
  removeManagedWorktree,
  saveState,
  setWorktreeLabel,
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

/** The repo reached through a symlink — like a code folder on another disk, or `/home` → `/var/home`. */
function linkTo(real: string) {
  const link = join(sandbox.root, "linked-widget");
  symlinkSync(real, link);
  return link;
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

  test("keeps UI preferences (the sidebar width) across a save and reload", async () => {
    const state = loadState();
    state.ui = { sidebarWidth: 52 };
    await saveState(state);
    expect(loadState().ui).toEqual({ sidebarWidth: 52 });
  });

  test("keeps the folded PR panel sections and the last merge method", async () => {
    const state = loadState();
    state.ui = { prPanelCollapsed: ["description", "comments"], mergeMethod: "rebase" };
    await saveState(state);
    expect(loadState().ui).toEqual({ prPanelCollapsed: ["description", "comments"], mergeMethod: "rebase" });
  });

  test("drops malformed folded sections and merge methods", () => {
    mkdirSync(join(sandbox.configHome, "agentree"), { recursive: true });
    const ui = { prPanelCollapsed: ["checks", 3, null], mergeMethod: "yolo" };
    writeFileSync(sandbox.stateFile, JSON.stringify({ version: 1, repos: [], ui }));
    expect(loadState().ui).toEqual({ prPanelCollapsed: ["checks"] });
  });

  test("ignores a malformed sidebar width instead of trusting it", () => {
    mkdirSync(join(sandbox.configHome, "agentree"), { recursive: true });
    for (const sidebarWidth of ["wide", -5, 0, null]) {
      writeFileSync(sandbox.stateFile, JSON.stringify({ version: 1, repos: [], ui: { sidebarWidth } }));
      expect(loadState().ui).toBeUndefined();
    }
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

describe("removeManagedWorktree", () => {
  test("drops it from state and persists", async () => {
    const state = loadState();
    await addManagedWorktree(state, meta("/tmp/widget"), {
      id: "feat-x",
      branch: "feature/x",
      name: "x",
      path: "/tmp/widget/.worktrees/feat-x",
      createdAt: "2026-01-01T00:00:00Z",
    });

    await removeManagedWorktree(state, "acme/widget", "feat-x");
    expect(findRepo(state, "acme/widget")!.worktrees).toEqual([]);
    expect(sandbox.readState()!.repos[0]!.worktrees).toEqual([]);
  });

  test("is a no-op for an unknown repo or worktree id", async () => {
    const state = loadState();
    upsertRepo(state, meta("/tmp/widget"));

    await removeManagedWorktree(state, "acme/widget", "nope");
    await removeManagedWorktree(state, "nope/nope", "nope");
    expect(findRepo(state, "acme/widget")!.worktrees).toEqual([]);
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

  test("does not re-adopt a missing worktree as a duplicate on a later reconcile", async () => {
    // Its directory was `rm -rf`'d rather than removed with `git worktree
    // remove`, so git still lists it (as "prunable") even though it's gone.
    const root = await fixtureRepo([{ branch: "feature/x" }]);
    const state = loadState();
    upsertRepo(state, meta(root));
    await reconcile(state); // adopt it
    rmSync(join(root, ".worktrees", "feature-x"), { recursive: true, force: true });
    await reconcile(state); // first reconcile after it vanished: marks missing

    const projects = await reconcile(state); // a second reconcile shouldn't duplicate it
    expect(projects[0]!.worktrees.filter((w) => w.name === "x")).toHaveLength(1);
    expect(findRepo(state, "acme/widget")!.worktrees).toHaveLength(1);
  });

  test("a repo reached through a symlink: its main copy and worktrees match git's real paths", async () => {
    const root = linkTo(await fixtureRepo([{ branch: "feature/x" }]));
    const state = loadState();
    upsertRepo(state, meta(root));

    const projects = await reconcile(state);
    expect(projects[0]!.worktrees.map((w) => w.name).sort()).toEqual(["main", "x"]);
    expect(projects[0]!.worktrees.find((w) => w.id === "main")).toMatchObject({ path: root });
    await reconcile(state); // and nothing is adopted twice
    expect(findRepo(state, "acme/widget")!.worktrees).toHaveLength(1);
  });

  test("a missing worktree under a symlinked repo stays one missing worktree", async () => {
    const real = await fixtureRepo([{ branch: "feature/x" }]);
    const root = linkTo(real);
    const state = loadState();
    // Stored under the path agentree was given, as when it creates a worktree.
    await addManagedWorktree(state, meta(root), {
      id: "feature-x",
      branch: "feature/x",
      name: "x",
      path: join(root, ".worktrees", "feature-x"),
      createdAt: "",
    });
    rmSync(join(real, ".worktrees", "feature-x"), { recursive: true, force: true });

    const projects = await reconcile(state);
    expect(projects[0]!.worktrees.filter((w) => w.name === "x")).toMatchObject([{ missing: true }]);
    expect(findRepo(state, "acme/widget")!.worktrees).toHaveLength(1);
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
      expect(w).toMatchObject({ dirty: false, changed: 0, added: 0, removed: 0, ahead: 0, behind: 0, agent: "none" });
    }
    const persisted = sandbox.readState() as State;
    expect(JSON.stringify(persisted)).not.toContain("dirty");
  });
});

describe("worktree labels", () => {
  test("a label shows instead of the name; the branch, path and id stay as they were", async () => {
    const root = await fixtureRepo([{ branch: "feature/login" }]);
    const state = loadState();
    upsertRepo(state, meta(root));
    const before = (await reconcile(state))[0]!.worktrees.find((w) => w.branch === "feature/login")!;

    await setWorktreeLabel(state, "acme/widget", before.id, "Login screen");
    const after = (await reconcile(loadState()))[0]!.worktrees.find((w) => w.id === before.id)!;
    expect(after).toMatchObject({
      id: before.id,
      name: before.name,
      branch: "feature/login",
      path: before.path,
      label: "Login screen",
    });
    expect(await git(["branch", "--list", "feature/login"], root)).toContain("feature/login");
  });

  test("the main working copy can be labelled too", async () => {
    const root = await fixtureRepo();
    const state = loadState();
    upsertRepo(state, meta(root));
    await saveState(state);
    await setWorktreeLabel(state, "acme/widget", "main", "Trunk");
    const main = (await reconcile(loadState()))[0]!.worktrees.find((w) => w.id === "main")!;
    expect(main).toMatchObject({ label: "Trunk", branch: "main" });
  });

  test("a missing worktree keeps its label", async () => {
    const root = await fixtureRepo([{ branch: "feature/x" }]);
    const state = loadState();
    upsertRepo(state, meta(root));
    const wt = (await reconcile(state))[0]!.worktrees.find((w) => w.branch === "feature/x")!;
    await setWorktreeLabel(state, "acme/widget", wt.id, "Spike");
    rmSync(wt.path, { recursive: true, force: true });
    const after = (await reconcile(state))[0]!.worktrees.find((w) => w.id === wt.id)!;
    expect(after).toMatchObject({ missing: true, label: "Spike" });
  });

  test("clearing a label (blank) goes back to the name and leaves no trace in state", async () => {
    const state = loadState();
    upsertRepo(state, meta("/tmp/widget"));
    await setWorktreeLabel(state, "acme/widget", "x", "Spike");
    expect(findRepo(loadState(), "acme/widget")!.labels).toEqual({ x: "Spike" });
    await setWorktreeLabel(state, "acme/widget", "x", "   ");
    expect(findRepo(loadState(), "acme/widget")!.labels).toBeUndefined();
  });

  test("closing a worktree forgets its label, so a new one with that id starts clean", async () => {
    const root = await fixtureRepo();
    const state = loadState();
    await addManagedWorktree(state, meta(root), {
      id: "x",
      branch: "feature/x",
      name: "x",
      path: join(root, ".worktrees", "x"),
      createdAt: "",
    });
    await setWorktreeLabel(state, "acme/widget", "x", "Spike");
    await setWorktreeLabel(state, "acme/widget", "main", "Trunk");
    await removeManagedWorktree(state, "acme/widget", "x");
    expect(findRepo(loadState(), "acme/widget")!.labels).toEqual({ main: "Trunk" });
  });

  test("a hand-edited, malformed label is ignored rather than shown", async () => {
    const root = await fixtureRepo();
    const state = loadState();
    upsertRepo(state, meta(root));
    (findRepo(state, "acme/widget")! as { labels?: unknown }).labels = { main: 42 };
    const main = (await reconcile(state))[0]!.worktrees.find((w) => w.id === "main")!;
    expect(main.label).toBeUndefined();
  });

  test("labels are trimmed, whitespace collapsed, and capped", () => {
    expect(normalizeLabel("  Login \t screen \n")).toBe("Login screen");
    expect(normalizeLabel("")).toBeUndefined();
    expect(normalizeLabel(undefined)).toBeUndefined();
    expect(Array.from(normalizeLabel("ż".repeat(100))!)).toHaveLength(MAX_LABEL_LENGTH);
  });
});

describe("SSH hosts", () => {
  const home = "/home/dev";

  test("a directory on a new host adds the host; reconcile lists it after the repos", async () => {
    const root = await fixtureRepo();
    const state = loadState();
    upsertRepo(state, meta(root));
    await addRemoteDir(state, "dev-box", { path: "/home/dev/code/api", home });

    const projects = await reconcile(loadState());
    expect(projects.map((p) => p.id)).toEqual(["acme/widget", "ssh:dev-box"]);
    const ssh = projects[1]!;
    expect(ssh).toMatchObject({ name: "dev-box", ssh: { host: "dev-box" } });
    expect(ssh.worktrees).toEqual([
      expect.objectContaining({
        id: "api",
        name: "api",
        path: "/home/dev/code/api",
        subtitle: "~/code/api",
        host: "dev-box",
      }),
    ]);
  });

  test("ids are distinct, the home directory shows as ~, and a directory isn't added twice", async () => {
    const state = loadState();
    const a = await addRemoteDir(state, "dev-box", { path: "/home/dev/a/api", home });
    const b = await addRemoteDir(state, "dev-box", { path: "/home/dev/b/api", home });
    const h = await addRemoteDir(state, "dev-box", { path: "/home/dev", home });
    const again = await addRemoteDir(state, "dev-box", { path: "/home/dev/a/api", home });
    expect([a, b, again]).toEqual(["api", "api-1", "api"]);
    expect(findHost(loadState(), "dev-box")!.dirs.map((d) => d.id)).toEqual(["api", "api-1", h]);
    const projects = await reconcile(loadState());
    expect(projects[0]!.worktrees.map((w) => w.name)).toEqual(["api", "api", "~"]);
  });

  test("forgetting a directory drops its label; forgetting the last host leaves no trace", async () => {
    const state = loadState();
    await addRemoteDir(state, "dev-box", { path: "/srv/app", home });
    await setWorktreeLabel(state, "ssh:dev-box", "app", "Prod app");
    expect((await reconcile(loadState()))[0]!.worktrees[0]!.label).toBe("Prod app");

    await removeRemoteDir(state, "dev-box", "app");
    expect(findHost(loadState(), "dev-box")).toMatchObject({ dirs: [] });
    expect(findHost(loadState(), "dev-box")!.labels).toBeUndefined();
    await removeHost(state, "dev-box");
    expect(sandbox.readState()!.hosts).toBeUndefined();
  });

  test("malformed hosts in a hand-edited state file are dropped", () => {
    mkdirSync(join(sandbox.configHome, "agentree"), { recursive: true });
    const hosts = [{ host: "ok", dirs: [{ id: "x", path: "/x" }, { id: 3 }] }, { host: "" }, { nope: true }, "dev-box"];
    writeFileSync(sandbox.stateFile, JSON.stringify({ version: 1, repos: [], hosts }));
    expect(loadState().hosts as unknown).toEqual([{ host: "ok", dirs: [{ id: "x", path: "/x" }] }]);
  });
});
