/**
 * SSH projects: a remote host whose directories open as terminals on that
 * machine (tmux runs there too, so shells outlive the connection). No git
 * features — agentree only runs shells and tmux over ssh.
 *
 * Every connection goes through one multiplexed master per host
 * (`ControlMaster`), so the tab bar's once-a-second tmux polling reuses it
 * instead of doing an ssh handshake each time.
 */
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stateFilePath } from "../config";
import { run } from "./proc";

import { shellJoin, shq } from "./shell";

export { shellJoin, shq };

/**
 * Whether `host` is something to hand ssh as a destination: a ~/.ssh/config
 * alias, `user@host`, or `ssh://user@host:port`. Never an option (`-o…`).
 */
export function isValidHost(host: string): boolean {
  return /^[^\s-][^\s]*$/.test(host);
}

/**
 * A unix socket path can't be longer than ~104 bytes (108 on Linux, 104 on
 * macOS), and ssh refuses a ControlPath that is. `%C` expands to 40 hex chars.
 */
const MAX_SOCKET_PATH = 100;
const CONTROL_NAME_LENGTH = 40;

/**
 * Where the per-host master connections' sockets live: the first of these
 * short enough for a socket path — the runtime dir (made for sockets), next to
 * state.json, or a private directory in /tmp. None → undefined.
 */
function controlDir(): string | undefined {
  const uid = process.getuid?.() ?? 0;
  const candidates = [
    process.env.XDG_RUNTIME_DIR && join(process.env.XDG_RUNTIME_DIR, "agentree-ssh"),
    join(dirname(stateFilePath()), "ssh"),
    join("/tmp", `agentree-ssh-${uid}`),
  ].filter((d): d is string => !!d);
  for (const dir of candidates) {
    if (dir.length + 1 + CONTROL_NAME_LENGTH > MAX_SOCKET_PATH) continue;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Somewhere shared (/tmp), only a directory that's ours and private will do.
      const st = statSync(dir);
      if (st.uid !== uid || (st.mode & 0o077) !== 0) continue;
      return dir;
    } catch {
      // try the next one
    }
  }
  return undefined;
}

/**
 * Options for every agentree ssh call: share one master connection per host.
 * Without anywhere to put its socket, each call connects on its own (slower).
 */
export function sshOptions(): string[] {
  const dir = controlDir();
  if (!dir) return [];
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${join(dir, "%C")}`,
    "-o",
    "ControlPersist=10m",
  ];
}

/**
 * argv that runs `argv` on `host`. `tty` for an interactive terminal (a
 * password or host-key prompt can be answered there); otherwise batch mode, so
 * a background call fails fast instead of waiting on a prompt nobody sees.
 */
export function remoteArgv(host: string, argv: string[], opts: { tty?: boolean } = {}): string[] {
  return sshArgv(host, shellJoin(argv), opts.tty ?? false);
}

/**
 * argv that runs a POSIX shell command line on `host` (see remoteArgv). sshd
 * hands the command to the user's login shell, which may be fish or zsh, so
 * it's wrapped in `sh -c` to mean the same everywhere. (tmux still starts the
 * user's own shell in its panes.)
 */
function sshArgv(host: string, command: string, tty: boolean): string[] {
  const mode = tty ? ["-t"] : ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  return ["ssh", ...sshOptions(), ...mode, "--", host, `exec sh -c ${shq(command)}`];
}

/**
 * A remote path as a shell word: a leading `~` becomes `"$HOME"` (quoting
 * would stop the shell expanding it), the rest is quoted.
 */
export function remotePathExpr(path: string): string {
  if (path === "~") return `"$HOME"`;
  if (path.startsWith("~/")) return `"$HOME"/${shq(path.slice(2))}`;
  return shq(path);
}

/** A remote path for display: under the remote home → `~/…`. */
export function displayPath(path: string, home?: string): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

export interface RemoteDir {
  /** Absolute path on the remote. */
  path: string;
  /** The remote user's $HOME. */
  home: string;
}

/** The login was refused: the host wants a password (or the key's passphrase). */
export class SshAuthError extends Error {}

/**
 * Check a directory on `host` before adding it: that we can connect, that the
 * directory exists (resolved to an absolute path), and that tmux is installed
 * there. Throws a message fit to show — an SshAuthError when the login needs
 * a password.
 *
 * With `password`, the login answers ssh's password (or key passphrase)
 * prompt with it, and this connection becomes the host's shared one, which
 * everything after reuses without logging in again. The password isn't kept.
 */
export async function probeRemoteDir(
  host: string,
  path: string,
  opts: { password?: string } = {},
): Promise<RemoteDir> {
  const script = [
    `cd -- ${remotePathExpr(path)} || exit 3`,
    "pwd",
    `printf '%s\\n' "$HOME"`,
    "if command -v tmux >/dev/null 2>&1; then echo tmux; else echo no-tmux; fi",
  ].join("; ");
  const { code, stdout, stderr } =
    opts.password === undefined
      ? await run(sshArgv(host, script, false))
      : await runWithPassword(host, script, opts.password);
  if (code === 3) throw new Error(`${path} doesn't exist on ${host} (or isn't a directory).`);
  if (code !== 0 && /Permission denied/i.test(stderr)) {
    throw new SshAuthError(stderr.trim().split("\n").pop() || "Permission denied");
  }
  if (code !== 0) throw new Error(connectError(host, stderr));
  const [resolved, home, tmux] = stdout.trim().split("\n");
  if (!resolved) throw new Error(`Couldn't read ${path} on ${host}.`);
  if (tmux !== "tmux") {
    throw new Error(`tmux isn't installed on ${host} — agentree runs remote terminals in tmux, so they survive a dropped connection.`);
  }
  return { path: resolved, home: home || "" };
}

/**
 * Log in with a password: ssh asks SSH_ASKPASS instead of a terminal (forced,
 * so it never prompts on agentree's own terminal), and our helper answers
 * with the password, passed only in this ssh's environment. The connection
 * stays up as the host's shared one (ControlPersist), so later calls reuse it.
 */
async function runWithPassword(host: string, script: string, password: string) {
  const opts = sshOptions();
  if (opts.length === 0) {
    return { code: 255, stdout: "", stderr: "can't keep a connection to reuse, so a password login won't last" };
  }
  const argv = [
    "ssh",
    ...opts,
    "-T",
    "-o",
    "NumberOfPasswordPrompts=1",
    "-o",
    "ConnectTimeout=10",
    "--",
    host,
    `exec sh -c ${shq(script)}`,
  ];
  return run(argv, {
    env: {
      ...process.env,
      SSH_ASKPASS: askpassHelper(),
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY || ":0",
      AGENTREE_SSH_SECRET: password,
    },
  });
}

/**
 * Our SSH_ASKPASS: answers ssh's password or passphrase prompt with the secret
 * in its environment, and refuses anything else — a host-key question or a
 * one-time code mustn't be answered with the password. Holds no secret itself.
 */
export const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *assword*|*assphrase*) printf '%s\\n' "$AGENTREE_SSH_SECRET" ;;
  *) exit 1 ;;
esac
`;

function askpassHelper(): string {
  const file = join(controlDir() ?? dirname(stateFilePath()), "askpass");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, ASKPASS_SCRIPT, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}

/**
 * Whether there's a live shared connection to `host` (a local check; nothing
 * is sent to the host). For a password host, background calls only go ahead
 * when there is: each attempt to log in without one would count as a failed
 * login on the server, and a poll every second gets you locked out.
 */
export async function isConnected(host: string): Promise<boolean> {
  const opts = sshOptions();
  if (opts.length === 0) return false;
  try {
    return (await run(["ssh", ...opts, "-O", "check", "--", host])).code === 0;
  } catch {
    return false;
  }
}

/** ssh's complaint, with what to do about the usual ones. */
function connectError(host: string, stderr: string): string {
  const last = stderr.trim().split("\n").pop() || `ssh to ${host} failed`;
  if (/Host key verification failed/i.test(stderr)) {
    return `${last} — run \`ssh ${host}\` once in a terminal to check and accept its host key.`;
  }
  return last;
}

/**
 * Hosts named in ~/.ssh/config (`Host` lines, skipping patterns like `*`), as
 * suggestions when adding one. `AGENTREE_SSH_CONFIG` points elsewhere (tests).
 */
export function configuredHosts(): string[] {
  const file = process.env.AGENTREE_SSH_CONFIG || join(homedir(), ".ssh", "config");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseSshConfigHosts(text);
}

export function parseSshConfigHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*Host\s+(.+?)\s*$/i.exec(line.replace(/#.*/, ""));
    if (!m) continue;
    for (const name of m[1]!.split(/\s+/)) {
      if (!/[*?!]/.test(name) && !hosts.includes(name)) hosts.push(name);
    }
  }
  return hosts;
}
