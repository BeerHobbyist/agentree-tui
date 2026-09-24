/**
 * SSH projects: a remote host whose directories open as terminals on that
 * machine (tmux runs there too, so shells outlive the connection). No git
 * features — agentree only runs shells and tmux over ssh.
 *
 * Every connection goes through one multiplexed master per host
 * (`ControlMaster`), so the tab bar's once-a-second tmux polling reuses it
 * instead of doing an ssh handshake each time.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stateFilePath } from "../config";
import { run } from "./proc";

/** Quote one argument for a POSIX shell (the remote end of `ssh host <command>`). */
export function shq(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A shell command line from an argv, every argument quoted. */
export function shellJoin(argv: string[]): string {
  return argv.map(shq).join(" ");
}

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

/**
 * Check a directory on `host` before adding it: that we can connect without a
 * prompt, that the directory exists (resolved to an absolute path), and that
 * tmux is installed there. Throws a message fit to show.
 */
export async function probeRemoteDir(host: string, path: string): Promise<RemoteDir> {
  const script = [
    `cd -- ${remotePathExpr(path)} || exit 3`,
    "pwd",
    `printf '%s\\n' "$HOME"`,
    "if command -v tmux >/dev/null 2>&1; then echo tmux; else echo no-tmux; fi",
  ].join("; ");
  const { code, stdout, stderr } = await run(sshArgv(host, script, false));
  if (code === 3) throw new Error(`${path} doesn't exist on ${host} (or isn't a directory).`);
  if (code !== 0) throw new Error(connectError(host, stderr));
  const [resolved, home, tmux] = stdout.trim().split("\n");
  if (!resolved) throw new Error(`Couldn't read ${path} on ${host}.`);
  if (tmux !== "tmux") {
    throw new Error(`tmux isn't installed on ${host} — agentree runs remote terminals in tmux, so they survive a dropped connection.`);
  }
  return { path: resolved, home: home || "" };
}

/** ssh's complaint, with what to do about the usual ones. */
function connectError(host: string, stderr: string): string {
  const last = stderr.trim().split("\n").pop() || `ssh to ${host} failed`;
  if (/Permission denied|Host key verification failed|password/i.test(stderr)) {
    return `${last} — agentree connects without prompts: use key-based login (ssh-agent), and run \`ssh ${host}\` once in a terminal to accept its host key.`;
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
