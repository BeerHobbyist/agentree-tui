/** The agent CLI against a real tmux session (the test's own server). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../src/cli";
import { skillPath } from "../../src/services/skill";
import { sessionName } from "../../src/services/tmux";
import { loadState, saveState, upsertRepo } from "../../src/store";
import { makeRepo } from "../helpers/repo";
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

describe("the rest", () => {
  test("diff opens the working changes in a tab of their own", async () => {
    expect((await cli("diff")).out).toContain("git diff");
    expect(tabs().some((t) => t.includes(":diff:"))).toBe(true);
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
