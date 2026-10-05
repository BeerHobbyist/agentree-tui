/**
 * The CLI inside fence: its tab commands carried out by the app's broker, on
 * the sandbox's terms. A stand-in sandbox (`env`) marks what runs in it, and
 * where it started.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../src/cli";
import { type Broker, brokerTmux, SANDBOXED, startBroker } from "../../src/services/broker";
import { sessionName } from "../../src/services/tmux";
import { addManagedWorktree, loadState, saveState, upsertRepo } from "../../src/store";
import { git, makeRepo } from "../helpers/repo";
import { createSandbox, type Sandbox } from "../helpers/sandbox";

let sandbox: Sandbox;
let broker: Broker | null;
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
  process.env.AGENTREE_SESSION = session;
  broker = await startBroker();
  process.env.FENCE_SANDBOX = "1"; // what fence sets
  process.env.AGENTREE_SANDBOX_CMD = 'env IN_SANDBOX=yes SANDBOX_ROOT="$PWD"';
});
afterEach(() => {
  broker?.stop();
  delete process.env.AGENTREE_SESSION;
  sandbox.cleanup();
});

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function until(what: string, ok: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every pane of a session: "<window name> <sandboxed mark>". */
const panes = (s = session) => sh([...tmux(), "list-panes", "-s", "-t", s, "-F", `#{window_name} #{${SANDBOXED}}`]);

describe("the CLI inside fence, through the broker", () => {
  test("tab new runs the tab in the sandbox, started at the worktree — and the command typed into it", async () => {
    const web = join(root, "web");
    mkdirSync(web);
    const cmd = 'echo "$IN_SANDBOX at $SANDBOX_ROOT in $PWD"';
    const { code, out } = await cli("tab", "new", "--name", "dev", "--cwd", web, "--", "sh", "-c", cmd);
    expect(code).toBe(0);
    expect(out).toBe("1");
    await until("the output", async () => (await cli("tab", "read", "dev")).out.includes(`yes at ${root} in ${web}`));
    expect(panes()).toContain("dev 1");
  });

  test("tab send types only into tabs opened through it — never the user's shell", async () => {
    const own = await cli("tab", "send", "0", "echo", "escaped");
    expect(own.code).toBe(1);
    expect(own.err).toContain("types only into tabs opened from one");

    await cli("tab", "new", "--name", "sh");
    expect((await cli("tab", "send", "sh", "echo", "typed-$IN_SANDBOX")).code).toBe(0);
    await until("the typed line to run", async () => (await cli("tab", "read", "sh")).out.includes("typed-yes"));
  });

  test("a pane the user splits off a sandboxed tab isn't sandboxed", async () => {
    await cli("tab", "new", "--name", "sh");
    Bun.spawnSync([...tmux(), "split-window", "-t", `${session}:1`]); // a plain shell, now the tab's active pane
    expect((await cli("tab", "send", "sh", "echo", "escaped")).code).toBe(1);
  });

  test("a # in a tab name is refused: tmux reads names as formats, and #(…) would run a command", async () => {
    const marker = join(sandbox.root, "ran");
    const name = `#(touch ${marker})`;
    expect((await cli("tab", "new", "--name", name)).code).toBe(1);
    expect((await cli("tab", "rename", "0", name)).code).toBe(1);
    await Bun.sleep(200);
    expect(existsSync(marker)).toBe(false);
  });

  test("a key that is, or ends in, ; is refused: tmux would run what follows it as a command", async () => {
    const marker = join(sandbox.root, "ran");
    await cli("tab", "new", "--name", "sh");
    const r = await cli("tab", "send", "sh", "--key", ";", "--key", "run-shell", "--key", `touch ${marker}`);
    expect(r.code).toBe(1);
    expect((await cli("tab", "send", "sh", "--key", "x;")).code).toBe(1);
    await Bun.sleep(200);
    expect(existsSync(marker)).toBe(false);
  });

  test("without AGENTREE_SANDBOX_CMD it starts nothing, but still lists, reads and closes tabs", async () => {
    delete process.env.AGENTREE_SANDBOX_CMD;
    const r = await cli("tab", "new", "--name", "dev");
    expect(r.code).toBe(1);
    expect(r.err).toContain("AGENTREE_SANDBOX_CMD");
    expect(sh([...tmux(), "list-windows", "-t", session, "-F", "#{window_index}"])).toBe("0");
    expect((await cli("tab", "list")).out).toMatch(/^0\t/);
    expect((await cli("tab", "read", "0")).code).toBe(0);
  });

  test("--worktree starts that worktree's session in the sandbox, at the worktree's own directory", async () => {
    const wtRoot = join(root, ".worktrees", "feature");
    await git(["worktree", "add", wtRoot, "-b", "feature"], root);
    await addManagedWorktree(
      loadState(),
      { nameWithOwner: "acme/widget", name: "widget", root },
      { id: "feature", branch: "feature", name: "feature", path: wtRoot, createdAt: "" },
    );
    const wtSession = sessionName("acme/widget", "feature");
    expect((await cli("tab", "new", "--worktree", "feature", "--name", "claude")).code).toBe(0);
    expect(sh([...tmux(), "display", "-p", "-t", wtSession, "#{session_path}"])).toBe(wtRoot);
    expect(panes(wtSession).split("\n")).toEqual([expect.stringMatching(/ 1$/), "claude 1"]);
  });

  test("it starts no session that isn't a worktree's, wherever the request says it is", async () => {
    await expect(brokerTmux().newSession("agentree_elsewhere", "/")).rejects.toThrow("no worktree has");
  });

  test("diff opens in the sandbox too", async () => {
    expect((await cli("diff")).code).toBe(0);
    expect(panes()).toContain("diff 1");
  });

  test("one broker per tmux server", async () => {
    expect(await startBroker()).toBeNull();
  });
});
