/**
 * SSH projects against a fake `ssh` whose every host is this machine: probing a
 * directory before adding it, and tmux commands run "on the host".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { probeRemoteDir } from "../../src/services/ssh";
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
