/**
 * The broker: how an agent in a sandbox (fence) drives its tabs without
 * reaching tmux. tmux runs whatever it's asked to outside any sandbox, so a
 * sandbox let onto agentree's tmux socket could run anything, unsandboxed,
 * with one `tmux new-window`. Instead the app — outside the sandbox — listens
 * on a socket of its own (the one to allow) and carries out the CLI's tab
 * commands itself, on two conditions:
 *
 * - what it starts runs in the sandbox too: `AGENTREE_SANDBOX_CMD`, a command
 *   prefix, started at the session's worktree. Without that setting it starts
 *   nothing.
 * - it types (`tab send`) only into panes it started that way: typed into the
 *   user's own shell, a command would run outside the sandbox.
 *
 * Listing, reading, selecting, renaming and closing tabs work on any tab. The
 * CLI comes here when it runs inside fence ($FENCE_SANDBOX).
 */
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { loadState, type State } from "../store";
import { sessionName, socketName, tmuxOn, type Tmux } from "./tmux";

/** The tmux commands the CLI uses: all it can ask the broker for. */
const OPS = [
  "listWindows",
  "hasSession",
  "newSession",
  "openTab",
  "newWindowCmd",
  "capturePane",
  "sendText",
  "sendKeys",
  "selectWindow",
  "renameWindow",
  "killWindow",
  "sessionPath",
] as const satisfies readonly (keyof Tmux)[];

type Op = (typeof OPS)[number];

/** What the CLI drives its tabs with: tmux itself, or the broker. */
export type TabControl = Pick<Tmux, Op>;

/** Marks a pane the broker started in the sandbox. Only something outside it can set a tmux option. */
export const SANDBOXED = "@agentree-sandboxed";

/** The broker's socket, beside tmux's own (the directory tmux keeps private to the user). */
export function brokerSocketPath(): string {
  const tmp = realpathSync(process.env.TMUX_TMPDIR || "/tmp");
  return join(tmp, `tmux-${process.getuid?.() ?? 0}`, `${socketName()}.broker`);
}

/**
 * The argv that runs `program` in the sandbox: `prefix` (the user's setting,
 * read by /bin/sh) in front of it, started wherever tmux starts the pane —
 * the session's worktree, which is what the sandbox's "." then means — and
 * only inside it moving to `cwd`, so an agent's `--cwd` never widens it.
 */
export function sandboxArgv(prefix: string, program: string[], cwd?: string): string[] {
  const inside = cwd ? ["/bin/sh", "-c", 'cd -- "$1"; shift; exec "$@"', "sh", cwd, ...program] : program;
  return ["/bin/sh", "-c", `exec ${prefix} "$@"`, "sh", ...inside];
}

function sandboxPrefix(): string {
  const prefix = process.env.AGENTREE_SANDBOX_CMD?.trim();
  if (!prefix) {
    throw new Error(
      "agentree starts nothing for a sandboxed agent until AGENTREE_SANDBOX_CMD names the sandbox to start it in " +
        "(e.g. fence --settings ~/.config/fence/fence.json --) — set it where you start agentree",
    );
  }
  return prefix;
}

/** The user's shell, as a login shell — what tmux itself starts in a new tab. */
const loginShell = () => [process.env.SHELL || "/bin/sh", "-l"];

/**
 * Any string for tmux's argv. One that is, or ends in, ";" would end the tmux
 * command, and the arguments after it would be a command of their own.
 */
const text = (v: unknown): string => {
  if (typeof v !== "string") throw new Error("bad request");
  if (v.endsWith(";")) throw new Error(`"${v}": tmux would read its trailing ; as the end of a command`);
  return v;
};
/**
 * A session, target, tab name or directory: tmux reads those as formats, where
 * `#(…)` would have its server run a command — outside the sandbox.
 */
const plain = (v: unknown): string => {
  const s = text(v);
  if (s.includes("#")) throw new Error(`"${s}": tmux would read its # as a format, so it can't come from a sandbox`);
  return s;
};
const optionalPlain = (v: unknown) => (v === undefined || v === null ? undefined : plain(v));
const optionalText = (v: unknown) => (v === undefined || v === null ? undefined : text(v));
const whole = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error("bad request");
  return v;
};

/** The directory of the worktree a session belongs to, from agentree's state. */
function worktreeDir(state: State, session: string): string | undefined {
  for (const repo of state.repos) {
    for (const w of [{ id: "main", path: repo.root }, ...repo.worktrees]) {
      if (sessionName(repo.nameWithOwner, w.id) === session) return w.path;
    }
  }
  return undefined;
}

/** Open a tab running `program` in the sandbox, rooted at the session's worktree, and mark its pane. */
async function sandboxedTab(
  tmux: Tmux,
  session: string,
  opts: { name?: string; cwd?: string; select: boolean },
  program: string[],
): Promise<{ index: number; pane: string }> {
  const prefix = sandboxPrefix();
  const root = await tmux.sessionPath(session);
  if (!root) throw new Error(`no tmux session "${session}"`);
  const tab = await tmux.openTab(session, {
    name: opts.name,
    select: opts.select,
    cwd: plain(root),
    command: sandboxArgv(prefix, program, opts.cwd),
  });
  await tmux.tagPane(tab.pane, SANDBOXED);
  return tab;
}

/** The pane `target` types into — only one the broker started in the sandbox. */
async function sandboxedPane(tmux: Tmux, target: unknown): Promise<string> {
  const pane = await tmux.paneTag(plain(target), SANDBOXED);
  if (!pane) throw new Error(`no tab "${target}"`);
  if (!pane.tagged) {
    throw new Error(
      "from a sandbox, agentree types only into tabs opened from one (agentree tab new) — typed here, it would run outside the sandbox",
    );
  }
  return pane.pane;
}

const HANDLERS: Record<Op, (tmux: Tmux, args: unknown[]) => Promise<unknown>> = {
  listWindows: (t, [session]) => t.listWindows(plain(session)),
  hasSession: (t, [session]) => t.hasSession(plain(session)),
  sessionPath: (t, [session]) => t.sessionPath(plain(session)),
  capturePane: (t, [target, lines]) => t.capturePane(plain(target), whole(lines)),
  selectWindow: (t, [session, index]) => t.selectWindow(plain(session), whole(index)),
  renameWindow: (t, [session, index, name]) => t.renameWindow(plain(session), whole(index), plain(name)),
  killWindow: (t, [session, index]) => t.killWindow(plain(session), whole(index)),
  // Its directory comes from agentree's state, never from the request — and is a checkout.
  async newSession(t, [session]) {
    const name = plain(session);
    const dir = worktreeDir(loadState(), name);
    if (!dir) throw new Error(`no worktree has the session "${name}"`);
    if (!existsSync(join(plain(dir), ".git"))) throw new Error(`${dir} isn't a git checkout`);
    const pane = await t.newSession(name, dir, sandboxArgv(sandboxPrefix(), loginShell()));
    await t.tagPane(pane, SANDBOXED);
    return pane;
  },
  openTab(t, [session, opts]) {
    const o: Record<string, unknown> = typeof opts === "object" && opts !== null ? { ...opts } : {};
    const tab = { name: optionalPlain(o.name), cwd: optionalText(o.cwd), select: o.select === true };
    return sandboxedTab(t, plain(session), tab, loginShell());
  },
  async newWindowCmd(t, [session, cwd, command, name]) {
    const tab = { name: optionalPlain(name), cwd: optionalText(cwd), select: true };
    await sandboxedTab(t, plain(session), tab, ["/bin/sh", "-c", text(command)]);
  },
  async sendText(t, [target, value, enter]) {
    await t.sendText(await sandboxedPane(t, target), text(value), enter !== false);
  },
  async sendKeys(t, [target, ...keys]) {
    await t.sendKeys(await sandboxedPane(t, target), ...keys.map(text));
  },
};

type Reply = { ok: true; value?: unknown } | { ok: false; error: string };

async function answer(tmux: Tmux, line: string): Promise<Reply> {
  try {
    const { op, args } = JSON.parse(line) ?? {};
    if (typeof op !== "string" || !Object.hasOwn(HANDLERS, op) || !Array.isArray(args)) {
      throw new Error("bad request");
    }
    return { ok: true, value: await HANDLERS[op as Op](tmux, args) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Longest request read (a `tab send` of a long prompt fits many times over). */
const MAX_REQUEST = 1 << 20;

/** One request per connection: a JSON line in, a JSON line back. */
function serve(socket: Socket, tmux: Tmux): void {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk: string) => {
    buf += chunk;
    const end = buf.indexOf("\n");
    if (end < 0) {
      if (buf.length > MAX_REQUEST) socket.destroy();
      return;
    }
    socket.removeAllListeners("data");
    void answer(tmux, buf.slice(0, end)).then((reply) => socket.end(JSON.stringify(reply) + "\n"));
  });
}

/** Whether something is listening on `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export interface Broker {
  path: string;
  stop(): void;
}

/**
 * Listen for the sandboxed CLI. Null when another agentree already does (one
 * broker per tmux server; any of them carries out the same commands).
 */
export async function startBroker(): Promise<Broker | null> {
  const path = brokerSocketPath();
  if (await answers(path)) return null;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { uid, mode } = statSync(dir);
  if (uid !== process.getuid?.() || (mode & 0o077) !== 0) {
    throw new Error(`${dir} isn't private to you, so agentree won't listen there`);
  }
  rmSync(path, { force: true }); // left by an agentree that didn't exit cleanly
  const tmux = tmuxOn();
  const server = createServer((socket) => serve(socket, tmux));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  return {
    path,
    stop() {
      server.close();
      rmSync(path, { force: true });
    },
  };
}

/** Ask the broker to run one command. */
function call(op: Op, args: unknown[]): Promise<unknown> {
  const path = brokerSocketPath();
  return new Promise((resolve, reject) => {
    let buf = "";
    const socket = createConnection(path);
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy(new Error("agentree didn't answer")));
    socket.once("connect", () => socket.write(JSON.stringify({ op, args }) + "\n"));
    socket.on("data", (chunk: string) => {
      buf += chunk;
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      const unreachable = ["ENOENT", "ECONNREFUSED", "EPERM", "EACCES"].includes(err.code ?? "");
      reject(
        unreachable
          ? new Error(
              `can't reach agentree at ${path} — from a sandbox, tabs go through the app: is it open, and does the sandbox allow that socket?`,
            )
          : err,
      );
    });
    socket.once("close", () => {
      try {
        const reply = JSON.parse(buf) as Reply;
        if (reply.ok) resolve(reply.value);
        else reject(new Error(reply.error));
      } catch {
        reject(new Error("agentree hung up without answering"));
      }
    });
  });
}

/** The tab commands, carried out by the app's broker instead of by tmux here. */
export function brokerTmux(): TabControl {
  return Object.fromEntries(OPS.map((op) => [op, (...args: unknown[]) => call(op, args)])) as unknown as TabControl;
}
