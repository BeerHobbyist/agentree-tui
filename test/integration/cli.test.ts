/** The agent CLI against a real tmux session (the test's own server). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../src/cli";
import { skillPath } from "../../src/services/skill";
import { sessionName } from "../../src/services/tmux";
import { addManagedWorktree, loadState, saveState, upsertRepo } from "../../src/store";
import { commitAll, git, makeRemote, makeRepo, pushFromElsewhere, withUpstream, writeFile } from "../helpers/repo";
import { createSandbox, type Sandbox } from "../helpers/sandbox";

let sandbox: Sandbox;
let session: string;
let root: string;
const tmux = () => ["tmux", "-L", sandbox.tmuxSocket];
const sh = (a: string[]) => new TextDecoder().decode(Bun.spawnSync(a).stdout).trim();

beforeEach(async () => {
  sandbox = createSandbox();
  root = await makeRepo(join(sandbox.workspace, "widget"));
  const state = loadState();
  upsertRepo(state, { nameWithOwner: "acme/widget", name: "widget", root });
  await saveState(state);
  session = sessionName("acme/widget", "main");
  Bun.spawnSync([...tmux(), "new-session", "-d", "-s", session, "-c", root, "-x", "120", "-y", "30"]);
  process.env.AGENTREE_SESSION = session; // what the app's session gives its panes
});
afterEach(() => {
  delete process.env.AGENTREE_SESSION;
  sandbox.cleanup();
});

/** Run a CLI command; its exit code and output. */
async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const tabs = () =>
  sh([...tmux(), "list-windows", "-t", session, "-F", "#{window_index}:#{window_name}:#{window_active}"]).split("\n");

async function until(what: string, ok: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("agentree tab", () => {
  test("new opens a tab in the background, runs the command in its shell, and read shows it", async () => {
    const { code, out } = await cli("tab", "new", "--name", "dev", "--", "echo", "hello from dev");
    expect(code).toBe(0);
    expect(out).toBe("1");
    expect(tabs()).toEqual([expect.stringMatching(/^0:.*:1$/), "1:dev:0"]); // the agent's tab stays active
    await until("the output", async () => (await cli("tab", "read", "dev")).out.includes("hello from dev"));
  });

  test("list, rename, select, close", async () => {
    await cli("tab", "new", "--name", "logs");
    expect((await cli("tab", "list")).out).toContain("1\tlogs");
    expect(JSON.parse((await cli("tab", "list", "--json")).out)).toHaveLength(2);
    expect((await cli("tab", "rename", "logs", "server", "logs")).code).toBe(0);
    expect(tabs()[1]).toBe("1:server logs:0");
    await cli("tab", "select", "1");
    expect(tabs()[1]).toBe("1:server logs:1");
    expect((await cli("tab", "close", "server logs")).code).toBe(0);
    expect(tabs()).toHaveLength(1);
  });

  test("send types a line, or presses keys", async () => {
    await cli("tab", "new", "--name", "sh");
    await cli("tab", "send", "sh", "echo", "typed-by-agent");
    await until(
      "the typed line to run",
      async () => (await cli("tab", "read", "sh")).out.split("typed-by-agent").length >= 3,
    );
    await cli("tab", "send", "sh", "sleep 100");
    await Bun.sleep(200);
    expect((await cli("tab", "send", "sh", "--key", "C-c")).code).toBe(0);
    await until("Ctrl+C to stop it", async () => /\^C/.test((await cli("tab", "read", "sh")).out));
  });

  test("won't open a second tab with a name that's in use, or close the last tab", async () => {
    await cli("tab", "new", "--name", "dev");
    const dup = await cli("tab", "new", "--name", "dev");
    expect(dup.code).toBe(2);
    expect(dup.err).toContain('a tab named "dev" is already open (1)');
    await cli("tab", "close", "dev");
    const last = await cli("tab", "close", "0");
    expect(last.code).toBe(2);
    expect(last.err).toContain("only tab");
  });

  test("an unknown tab lists the real ones; outside agentree it says so", async () => {
    const r = await cli("tab", "read", "nope");
    expect(r.err).toMatch(/no tab "nope" — tabs: 0:/);
    delete process.env.AGENTREE_SESSION;
    const outside = await cli("tab", "list");
    expect(outside.code).toBe(2);
    expect(outside.err).toContain("not inside an agentree terminal");
  });
});

describe("agentree worktree new", () => {
  test("--repo PATH creates and registers a worktree, printing its id", async () => {
    const otherRoot = await makeRepo(join(sandbox.workspace, "other"));
    const { code, out } = await cli("worktree", "new", "--repo", otherRoot, "--branch", "agent/task");
    expect(code).toBe(0);
    expect(out).toBe("agent-task");
    const repo = loadState().repos.find((r) => r.root === otherRoot);
    expect(repo?.nameWithOwner).toBeTruthy();
    expect(repo?.worktrees).toEqual([expect.objectContaining({ id: "agent-task", branch: "agent/task" })]);
    expect(existsSync(join(otherRoot, ".worktrees", "agent-task"))).toBe(true);
  });

  test("--repo owner/name clones it first (via gh) when it isn't on disk yet", async () => {
    await makeRemote(sandbox, "acme/widget2");
    const { code, out } = await cli("worktree", "new", "--repo", "acme/widget2", "--branch", "agent/task");
    expect(code).toBe(0);
    expect(out).toBe("agent-task");
    expect(sandbox.ghCalls().some((c) => c.startsWith("repo clone acme/widget2"))).toBe(true);
    const repo = loadState().repos.find((r) => r.nameWithOwner === "acme/widget2");
    expect(repo?.root).toBe(join(sandbox.workspace, "widget2"));
    expect(existsSync(join(repo!.root, ".worktrees", "agent-task"))).toBe(true);
  });

  test("adopts a worktree that already exists on that branch instead of duplicating it", async () => {
    const otherRoot = await makeRepo(join(sandbox.workspace, "other2"), { worktrees: [{ branch: "agent/task" }] });
    const { code, out } = await cli("worktree", "new", "--repo", otherRoot, "--branch", "agent/task");
    expect(code).toBe(0);
    expect(out).toBe("agent-task");
    const repo = loadState().repos.find((r) => r.root === otherRoot);
    expect(repo?.worktrees).toHaveLength(1);
  });

  test("--base creates the new branch from a given ref, not current HEAD", async () => {
    const otherRoot = await makeRepo(join(sandbox.workspace, "other3"));
    await git(["checkout", "-b", "old"], otherRoot);
    writeFile(otherRoot, "marker.txt", "from old\n");
    await commitAll(otherRoot, "marker");
    await git(["checkout", "main"], otherRoot);

    const { code, out } = await cli(
      "worktree",
      "new",
      "--repo",
      otherRoot,
      "--branch",
      "agent/from-old",
      "--base",
      "old",
    );
    expect(code).toBe(0);
    expect(existsSync(join(otherRoot, ".worktrees", out, "marker.txt"))).toBe(true);
  });

  test("a new branch starts from its base's latest commit on the remote, fetched first", async () => {
    const otherRoot = await makeRepo(join(sandbox.workspace, "other4"));
    await withUpstream(otherRoot);
    const tip = await pushFromElsewhere(otherRoot);

    const { code } = await cli("worktree", "new", "--repo", otherRoot, "--branch", "agent/fresh", "--base", "main");
    expect(code).toBe(0);
    expect((await git(["rev-parse", "agent/fresh"], otherRoot)).trim()).toBe(tip);
  });

  test("a missing --repo or --branch is an error", async () => {
    expect((await cli("worktree", "new", "--branch", "x")).err).toContain("--repo needed");
    expect((await cli("worktree", "new", "--repo", "acme/widget")).err).toContain("--branch needed");
  });
});

describe("agentree tab new --worktree (cross-worktree)", () => {
  test("starts the worktree's session if it isn't running yet, then opens a tab in it", async () => {
    const wtRoot = join(root, ".worktrees", "feature");
    await git(["worktree", "add", wtRoot, "-b", "feature"], root);
    const state = loadState();
    await addManagedWorktree(
      state,
      { nameWithOwner: "acme/widget", name: "widget", root },
      { id: "feature", branch: "feature", name: "feature", path: wtRoot, createdAt: new Date().toISOString() },
    );
    const wtSession = sessionName("acme/widget", "feature");
    expect(Bun.spawnSync([...tmux(), "has-session", "-t", wtSession]).exitCode).not.toBe(0);

    const { code, out } = await cli(
      "tab",
      "new",
      "--worktree",
      "feature",
      "--name",
      "claude",
      "--",
      "echo",
      "hi from feature",
    );
    expect(code).toBe(0);
    expect(out).toBe("1"); // 0 is the session's own default shell window
    expect(Bun.spawnSync([...tmux(), "has-session", "-t", wtSession]).exitCode).toBe(0);

    await until("the output", async () => {
      const read = await cli("tab", "read", "claude", "--worktree", "feature");
      return read.out.includes("hi from feature");
    });
  });

  test("--repo disambiguates a worktree id that collides across repos; without it, it's an error", async () => {
    const widgetWt = join(root, ".worktrees", "feature");
    await git(["worktree", "add", widgetWt, "-b", "feature"], root);
    const otherRoot = await makeRepo(join(sandbox.workspace, "other4"));
    const otherWt = join(otherRoot, ".worktrees", "feature");
    await git(["worktree", "add", otherWt, "-b", "feature"], otherRoot);

    const state = loadState();
    await addManagedWorktree(
      state,
      { nameWithOwner: "acme/widget", name: "widget", root },
      { id: "feature", branch: "feature", name: "feature", path: widgetWt, createdAt: "" },
    );
    await addManagedWorktree(
      state,
      { nameWithOwner: "acme/other4", name: "other4", root: otherRoot },
      { id: "feature", branch: "feature", name: "feature", path: otherWt, createdAt: "" },
    );

    const ambiguous = await cli("tab", "new", "--worktree", "feature");
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.err).toContain("more than one repo");

    const picked = await cli("tab", "new", "--worktree", "feature", "--repo", "acme/other4");
    expect(picked.code).toBe(0);
  });

  test("an unknown worktree id is an error", async () => {
    const r = await cli("tab", "new", "--worktree", "nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain('no worktree "nope"');
  });
});

describe("the rest", () => {
  test("diff opens the working changes in a tab of their own", async () => {
    expect((await cli("diff")).out).toContain("git diff");
    expect(tabs().some((t) => t.includes(":diff:"))).toBe(true);
  });

  test("--help short-circuits every command, e.g. `diff --help` prints help instead of opening a diff", async () => {
    const before = tabs().length;
    const { code, out } = await cli("diff", "--help");
    expect(code).toBe(0);
    expect(out).toContain("agentree — git worktrees with agent terminals");
    expect(tabs()).toHaveLength(before);
  });

  test("notify tells the user, titled with the worktree", async () => {
    expect((await cli("notify", "Migration", "ready")).code).toBe(0);
    await until("the notification", () => sandbox.notifications().length > 0);
    expect(sandbox.notifications()).toEqual(["main — widget | Migration ready"]);
  });

  test("status lists the worktrees, marking the one you're in", async () => {
    const rows = JSON.parse((await cli("status", "--json")).out);
    expect(rows).toEqual([expect.objectContaining({ project: "widget", worktree: "main", agent: "none", here: true })]);
    expect((await cli("status")).out).toBe("* widget/main\tnone");
  });

  test("skill install puts it in Claude's skills; uninstall takes it out", async () => {
    expect((await cli("skill", "install")).code).toBe(0);
    expect(readFileSync(skillPath(), "utf8")).toContain("name: agentree");
    expect((await cli("skill", "show")).out).toContain("— installed");
    await cli("skill", "uninstall");
    expect(existsSync(skillPath())).toBe(false);
  });

  test("the entry point dispatches: `agentree tab list` runs the CLI, not the app", () => {
    const res = Bun.spawnSync(["bun", join(import.meta.dir, "../../src/index.tsx"), "tab", "list"], {
      env: { ...process.env, AGENTREE_SESSION: session },
    });
    expect(res.exitCode).toBe(0);
    expect(new TextDecoder().decode(res.stdout)).toMatch(/^0\t/);
  });
});
