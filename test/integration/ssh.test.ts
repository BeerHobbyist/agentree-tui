/**
 * SSH projects against a fake `ssh` whose every host is this machine: probing a
 * directory before adding it, and tmux commands run "on the host".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASKPASS_SCRIPT, isConnected, probeRemoteDir, SshAuthError } from "../../src/services/ssh";
import { tmuxOn } from "../../src/services/tmux";
import { createSandbox, type Sandbox } from "../helpers/sandbox";

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

describe("probeRemoteDir", () => {
  test("resolves ~ and ~/… to absolute paths on the host, and reads its home", async () => {
    mkdirSync(join(sandbox.sshHome, "code", "api"), { recursive: true });
    expect(await probeRemoteDir("dev-box", "~")).toEqual({ path: sandbox.sshHome, home: sandbox.sshHome });
    expect((await probeRemoteDir("dev-box", "~/code/api")).path).toBe(join(sandbox.sshHome, "code", "api"));
  });

  test("connects in batch mode, through the shared connection", async () => {
    await probeRemoteDir("dev-box", "~");
    const call = sandbox.sshCalls().at(-1)!;
    expect(call).toContain("BatchMode=yes");
    expect(call).toContain("ControlMaster=auto");
    expect(call).toContain("-- dev-box ");
  });

  test("a directory that isn't there says so", async () => {
    await expect(probeRemoteDir("dev-box", "~/nope")).rejects.toThrow("~/nope doesn't exist on dev-box");
  });

  test("a host without tmux is refused — its terminals couldn't outlive the connection", async () => {
    sandbox.failSsh("no-tmux");
    await expect(probeRemoteDir("dev-box", "~")).rejects.toThrow("tmux isn't installed on dev-box");
  });

  test("a failed connection passes on ssh's message", async () => {
    sandbox.failSsh("connect");
    await expect(probeRemoteDir("dev-box", "~")).rejects.toThrow("Connection refused");
  });
});

describe("tmux on a host", () => {
  test("session and window commands run over ssh", async () => {
    const tmux = ["tmux", "-L", sandbox.tmuxSocket];
    Bun.spawnSync([...tmux, "new-session", "-d", "-s", "remote-s", "-c", sandbox.sshHome, "sleep 60"]);
    const remote = tmuxOn("dev-box");

    expect(await remote.hasSession("remote-s")).toBe(true);
    expect((await remote.listWindows("remote-s")).length).toBe(1);
    await remote.newWindow("remote-s", sandbox.sshHome);
    expect((await remote.listWindows("remote-s")).length).toBe(2);
    await remote.renameWindow("remote-s", 1, "logs & more");
    expect((await remote.listWindows("remote-s"))[1]!.name).toBe("logs & more");
    await remote.killSession("remote-s");
    expect(await remote.hasSession("remote-s")).toBe(false);

    expect(sandbox.sshCalls().every((c) => c.includes("-- dev-box exec sh -c 'tmux -u -L "))).toBe(true);
  });
});

describe("hosts that log in with a password", () => {
  test("our askpass answers only password and passphrase prompts", () => {
    const helper = join(sandbox.root, "askpass");
    writeFileSync(helper, ASKPASS_SCRIPT, { mode: 0o700 });
    const ask = (prompt: string) =>
      Bun.spawnSync([helper, prompt], { env: { ...process.env, AGENTREE_SSH_SECRET: "s3cret pass" } });
    const answer = (prompt: string) => new TextDecoder().decode(ask(prompt).stdout);
    expect(answer("dev-box's password: ")).toBe("s3cret pass\n");
    expect(answer("Enter passphrase for key '/home/me/.ssh/id_ed25519': ")).toBe("s3cret pass\n");
    // A host-key question or a one-time code must never get the password.
    const hostKey = ask("Are you sure you want to continue connecting (yes/no/[fingerprint])? ");
    expect(hostKey.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(hostKey.stdout)).toBe("");
    expect(ask("Verification code: ").exitCode).not.toBe(0);
  });

  test("without the password the probe says it's needed; a wrong one is refused", async () => {
    sandbox.requireSshPassword("hunter2");
    await expect(probeRemoteDir("dev-box", "~")).rejects.toBeInstanceOf(SshAuthError);
    await expect(probeRemoteDir("dev-box", "~", { password: "nope" })).rejects.toBeInstanceOf(SshAuthError);
    expect(sandbox.sshConnected()).toBe(false);
  });

  test("the right password opens the shared connection, which later calls reuse", async () => {
    sandbox.requireSshPassword("hunter2");
    expect(await isConnected("dev-box")).toBe(false);
    expect((await probeRemoteDir("dev-box", "~", { password: "hunter2" })).path).toBe(sandbox.sshHome);
    expect(await isConnected("dev-box")).toBe(true);
    expect((await probeRemoteDir("dev-box", "~")).path).toBe(sandbox.sshHome); // no password now
    // The password went to ssh through the environment, never on its command line.
    expect(sandbox.sshCalls().join("\n")).not.toContain("hunter2");
  });

  test("background tmux calls wait for a connection instead of trying to log in", async () => {
    sandbox.requireSshPassword("hunter2");
    const remote = tmuxOn("dev-box", { onlyIfConnected: true });
    expect(await remote.listWindows("any")).toEqual([]);
    expect(await remote.hasSession("any")).toBe(false);
    expect(sandbox.sshLoginAttempts()).toEqual([]); // not a single failed login

    await probeRemoteDir("dev-box", "~", { password: "hunter2" });
    Bun.spawnSync(["tmux", "-L", sandbox.tmuxSocket, "new-session", "-d", "-s", "pw-s", "sleep 60"]);
    expect(await remote.hasSession("pw-s")).toBe(true);
  });
});
