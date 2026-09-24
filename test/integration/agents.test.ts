/**
 * Agent status end to end below the UI: the hook command run by a real shell,
 * the hooks settings file, and reading reports back against a real tmux server.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentStatusDir,
  ensureHooksSettings,
  hookCommand,
  hooksSettingsPath,
  readAgentStatuses,
  readRemoteAgentStatuses,
  remoteAgentDir,
  setRemoteTracking,
  setTrackingEveryClaude,
  trackingEveryClaude,
} from "../../src/services/agents";
import { dirname } from "node:path";
import { createSandbox, type Sandbox } from "../helpers/sandbox";

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => {
  sandbox.cleanup();
});

/** Run a hook command the way Claude Code does (`sh -c`), with the given env. */
function runHook(command: string, env: Record<string, string>) {
  const res = Bun.spawnSync(["sh", "-c", command], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  return {
    code: res.exitCode,
    stdout: new TextDecoder().decode(res.stdout),
    stderr: new TextDecoder().decode(res.stderr),
  };
}

const agentEnv = () => ({
  AGENTREE_AGENT_DIR: agentStatusDir(),
  AGENTREE_SESSION: "agentree_widget_x",
  TMUX_PANE: "%7",
});

describe("hookCommand", () => {
  test("writes '<state> <epoch>' for its session and pane, silently", () => {
    const before = Math.floor(Date.now() / 1000);
    const res = runHook(hookCommand("needs-action"), agentEnv());
    expect(res).toEqual({ code: 0, stdout: "", stderr: "" }); // stdout would reach Claude's context
    const [state, since] = readFileSync(join(agentStatusDir(), "agentree_widget_x.7"), "utf8").trim().split(" ");
    expect(state).toBe("needs-action");
    expect(Number(since)).toBeGreaterThanOrEqual(before);
  });

  test("does nothing outside an agentree session", () => {
    const res = runHook(hookCommand("working"), { TMUX_PANE: "%7" });
    expect(res).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(agentStatusDir())).toBe(false);
  });

  test("'gone' removes the report", () => {
    runHook(hookCommand("working"), agentEnv());
    runHook(hookCommand("gone"), agentEnv());
    expect(existsSync(join(agentStatusDir(), "agentree_widget_x.7"))).toBe(false);
  });
});

describe("ensureHooksSettings", () => {
  test("writes a valid settings file once, and repairs a stale one", () => {
    const path = ensureHooksSettings();
    expect(path).toBe(hooksSettingsPath());
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).hooks)).toContain("Stop");

    const mtime = statSync(path).mtimeMs;
    ensureHooksSettings();
    expect(statSync(path).mtimeMs).toBe(mtime); // unchanged → not rewritten

    writeFileSync(path, "{}");
    ensureHooksSettings();
    expect(JSON.parse(readFileSync(path, "utf8")).hooks).toBeDefined();
  });
});

describe("readAgentStatuses", () => {
  /** A detached session with one long-running pane; returns the pane number. */
  function livePane(session: string): string {
    Bun.spawnSync(["tmux", "-L", sandbox.tmuxSocket, "new-session", "-d", "-s", session, "sleep 300"]);
    const out = Bun.spawnSync(["tmux", "-L", sandbox.tmuxSocket, "display", "-p", "-t", session, "#{pane_id}"]);
    return new TextDecoder().decode(out.stdout).trim().replace("%", "");
  }
  function splitPane(session: string): string {
    const out = Bun.spawnSync([
      "tmux",
      "-L",
      sandbox.tmuxSocket,
      "split-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      session,
      "sleep 300",
    ]);
    return new TextDecoder().decode(out.stdout).trim().replace("%", "");
  }
  function report(session: string, pane: string, content: string) {
    mkdirSync(agentStatusDir(), { recursive: true });
    writeFileSync(join(agentStatusDir(), `${session}.${pane}`), content);
  }
  const now = () => Math.floor(Date.now() / 1000);

  test("returns the report of a live pane", async () => {
    const pane = livePane("agentree_a");
    report("agentree_a", pane, `done ${now()}\n`);
    const statuses = await readAgentStatuses();
    expect(statuses.get("agentree_a")?.state).toBe("done");
  });

  test("drops and deletes the report of a pane that's gone", async () => {
    livePane("agentree_a"); // a server is running, but not this pane:
    report("agentree_a", "999", `working ${now()}\n`);
    const statuses = await readAgentStatuses();
    expect(statuses.has("agentree_a")).toBe(false);
    expect(existsSync(join(agentStatusDir(), "agentree_a.999"))).toBe(false);
  });

  test("treats every report as stale when no tmux server is running", async () => {
    report("agentree_a", "1", `working ${now()}\n`);
    expect((await readAgentStatuses()).size).toBe(0);
    expect(existsSync(join(agentStatusDir(), "agentree_a.1"))).toBe(false);
  });

  test("combines a session's agents, most urgent first", async () => {
    const first = livePane("agentree_a");
    const second = splitPane("agentree_a");
    report("agentree_a", first, `working ${now()}\n`);
    report("agentree_a", second, `needs-action ${now()}\n`);
    expect((await readAgentStatuses()).get("agentree_a")?.state).toBe("needs-action");
  });

  test("a 'working' pane that has been silent for a while reads as idle", async () => {
    const pane = livePane("agentree_a");
    const t = now();
    report("agentree_a", pane, `working ${t}\n`);
    // Pretend it's much later: nothing has printed since the pane started.
    expect((await readAgentStatuses(t + 60)).get("agentree_a")?.state).toBe("idle");
  });
});

describe("tracking every claude (Claude's user settings)", () => {
  test("turning it on adds the hooks to existing settings; off takes only them out", () => {
    mkdirSync(dirname(sandbox.claudeSettings), { recursive: true });
    const mine = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    writeFileSync(sandbox.claudeSettings, JSON.stringify(mine));
    expect(trackingEveryClaude()).toBe(false);

    setTrackingEveryClaude(true);
    expect(trackingEveryClaude()).toBe(true);
    const on = JSON.parse(readFileSync(sandbox.claudeSettings, "utf8"));
    expect(on.model).toBe("opus");
    expect(JSON.stringify(on.hooks.Stop)).toContain("say done");
    expect(JSON.stringify(on.hooks.Stop)).toContain("AGENTREE_AGENT_DIR");

    setTrackingEveryClaude(false);
    expect(JSON.parse(readFileSync(sandbox.claudeSettings, "utf8"))).toEqual(mine);
  });

  test("a settings file that isn't valid JSON is left alone", () => {
    mkdirSync(dirname(sandbox.claudeSettings), { recursive: true });
    writeFileSync(sandbox.claudeSettings, "{ oops");
    expect(() => setTrackingEveryClaude(true)).toThrow("isn't valid JSON");
    expect(readFileSync(sandbox.claudeSettings, "utf8")).toBe("{ oops");
  });

  test("the hooks, run by any process in an agentree session, report its status", async () => {
    setTrackingEveryClaude(true);
    const settings = JSON.parse(readFileSync(sandbox.claudeSettings, "utf8"));
    const permission = settings.hooks.Notification[0].hooks[0].command;
    expect(runHook(permission, agentEnv()).code).toBe(0);
    expect(readFileSync(join(agentStatusDir(), "agentree_widget_x.7"), "utf8")).toStartWith("needs-action ");
    // Outside an agentree session they do nothing.
    expect(runHook(permission, { TMUX_PANE: "%7" }).code).toBe(0);
  });
});

describe("agents on an SSH host", () => {
  const tmux = () => ["tmux", "-L", sandbox.tmuxSocket];
  /** A session on the "host" (the fake ssh runs everything here); returns its pane number. */
  function remotePane(session: string): string {
    Bun.spawnSync([...tmux(), "new-session", "-d", "-s", session, "sleep 300"]);
    const out = Bun.spawnSync([...tmux(), "display", "-p", "-t", session, "#{pane_id}"]);
    return new TextDecoder().decode(out.stdout).trim().replace("%", "");
  }

  test("their reports are read on the host, in one ssh call", async () => {
    const pane = remotePane("remote_s");
    const dir = remoteAgentDir(sandbox.sshHome);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `remote_s.${pane}`), `needs-action ${Math.floor(Date.now() / 1000)}\n`);
    writeFileSync(join(dir, "gone_s.99"), `working ${Math.floor(Date.now() / 1000)}\n`);
    const before = sandbox.sshCalls().length;

    const statuses = await readRemoteAgentStatuses("dev-box", sandbox.sshHome);
    expect(statuses.get("remote_s")?.state).toBe("needs-action");
    expect(statuses.has("gone_s")).toBe(false);
    expect(existsSync(join(dir, "gone_s.99"))).toBe(false); // stale: deleted on the host
    expect(sandbox.sshCalls().length - before).toBe(2); // the read, and that delete
  });

  test("a password host that isn't connected isn't asked (no login from a poll)", async () => {
    sandbox.requireSshPassword("hunter2");
    expect((await readRemoteAgentStatuses("dev-box", sandbox.sshHome, { onlyIfConnected: true })).size).toBe(0);
    expect(sandbox.sshLoginAttempts()).toEqual([]);
  });

  test("tracking on the host merges the hooks into its Claude settings", async () => {
    const remote = join(sandbox.sshHome, ".claude", "settings.json");
    mkdirSync(dirname(remote), { recursive: true });
    writeFileSync(remote, JSON.stringify({ theme: "dark" }));
    expect(await setRemoteTracking("dev-box", true)).toBe("changed");
    expect(await setRemoteTracking("dev-box", true)).toBe("unchanged");
    const on = JSON.parse(readFileSync(remote, "utf8"));
    expect(on.theme).toBe("dark");
    expect(JSON.stringify(on.hooks)).toContain("AGENTREE_AGENT_DIR");
    expect(await setRemoteTracking("dev-box", false)).toBe("changed");
    expect(JSON.parse(readFileSync(remote, "utf8"))).toEqual({ theme: "dark" });
    // …and never touched this machine's.
    expect(existsSync(sandbox.claudeSettings)).toBe(false);
  });
});
