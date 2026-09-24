/**
 * Desktop notifications — "an agent needs you" while you're elsewhere.
 * macOS: osascript; Linux: notify-send, when installed. `AGENTREE_NOTIFY_CMD`
 * runs a command of your own instead (given the title and body), and
 * `AGENTREE_NOTIFY=off` turns them off. Fire and forget: a missing or failing
 * notifier never gets in the way.
 */

/** A string literal for AppleScript. */
function appleString(s: string): string {
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

/** The command that shows a notification here, if there's one. */
export function notifyCommand(
  title: string,
  body: string,
  platform: string = process.platform,
  which: (cmd: string) => string | null = (cmd) => Bun.which(cmd, { PATH: process.env.PATH }),
): string[] | null {
  const custom = process.env.AGENTREE_NOTIFY_CMD;
  if (custom) return [custom, title, body];
  if (platform === "darwin") {
    return ["osascript", "-e", `display notification ${appleString(body)} with title ${appleString(title)}`];
  }
  if (which("notify-send")) return ["notify-send", "--app-name=agentree", title, body];
  return null;
}

export function notify(title: string, body: string): void {
  const mode = (process.env.AGENTREE_NOTIFY ?? "").toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false") return;
  const argv = notifyCommand(title, body);
  if (!argv) return;
  try {
    Bun.spawn(argv, { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    // no notifier after all
  }
}
