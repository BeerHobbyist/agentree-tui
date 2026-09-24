/** Which notifier agentree uses. */
import { afterEach, describe, expect, test } from "bun:test";
import { notifyCommand } from "../../src/services/notify";

const saved = process.env.AGENTREE_NOTIFY_CMD;
afterEach(() => {
  process.env.AGENTREE_NOTIFY_CMD = saved;
});

describe("notifyCommand", () => {
  const has =
    (...cmds: string[]) =>
    (cmd: string) =>
      cmds.includes(cmd) ? `/usr/bin/${cmd}` : null;

  test("macOS: osascript, with the text quoted for AppleScript", () => {
    delete process.env.AGENTREE_NOTIFY_CMD;
    expect(notifyCommand('say "hi"', "x\\y", "darwin", has())).toEqual([
      "osascript",
      "-e",
      'display notification "x\\\\y" with title "say \\"hi\\""',
    ]);
  });

  test("Linux: notify-send when it's there, else nothing", () => {
    delete process.env.AGENTREE_NOTIFY_CMD;
    expect(notifyCommand("t", "b", "linux", has("notify-send"))).toEqual([
      "notify-send",
      "--app-name=agentree",
      "t",
      "b",
    ]);
    expect(notifyCommand("t", "b", "linux", has())).toBeNull();
  });

  test("AGENTREE_NOTIFY_CMD runs your own command instead", () => {
    process.env.AGENTREE_NOTIFY_CMD = "/usr/local/bin/my-notify";
    expect(notifyCommand("t", "b", "darwin", has())).toEqual(["/usr/local/bin/my-notify", "t", "b"]);
  });
});
