/**
 * `agentree <command>`: control the agentree terminal you're in — for the
 * agents running there (and for you). Inside an agentree terminal the tmux
 * session is known ($AGENTREE_SESSION, set on every pane), so commands act on
 * that worktree's tabs; `--session` names another.
 *
 * Tabs are tmux windows, so the running app's tab bar shows every change.
 */
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { addManagedWorktree, findRepo, loadState, saveState, upsertRepo, type State, type StoredRepo } from "./store";
import { readAgentStatuses } from "./services/agents";
import { branchLeaf, repoDir, sanitizeBranchForPath, worktreePath } from "./config";
import { availableViewers, diffCommand, resolveViewer, type DiffTarget } from "./services/diff";
import { addWorktree, baseRef, canonicalPath, listWorktrees, localBranchExists } from "./services/git";
import { clone } from "./services/gh";
import { notify } from "./services/notify";
import { run } from "./services/proc";
import { shellJoin } from "./services/shell";
import { installSkill, skillPath, skillState, SKILL_TEXT, uninstallSkill } from "./services/skill";
import { sessionName, tmuxOn, type Tmux, type WindowInfo } from "./services/tmux";

const COMMANDS = ["tab", "tabs", "diff", "notify", "status", "skill", "worktree", "help"];

/** Whether these arguments are a CLI command (else the app starts). */
export function isCliInvocation(argv: string[]): boolean {
  const first = argv[0];
  return !!first && (COMMANDS.includes(first) || first === "--help" || first === "-h");
}

export const HELP = `agentree — git worktrees with agent terminals

Run with no arguments to open the app. Inside an agentree terminal, these
control that worktree's tabs (tmux windows; the app's tab bar follows):

  agentree tab list [--json]              the tabs: index, name, active
  agentree tab new [--name N] [--select] [--cwd DIR] [-- COMMAND...]
                    [--worktree ID] [--repo OWNER/NAME]
                                          open a tab (in the background unless
                                          --select); runs COMMAND in its shell;
                                          prints its index. --worktree targets
                                          another worktree's tabs instead of
                                          this one, starting its tmux session
                                          if it doesn't exist yet; --repo picks
                                          between worktree ids that collide
                                          across repos
  agentree tab read TAB [--lines N]       what TAB shows (last 50 lines)
  agentree tab send TAB TEXT...           type TEXT into TAB, then Enter
                    [--no-enter] [--key KEY]...   (KEY: tmux names, e.g. C-c)
  agentree tab select TAB                 switch to TAB
  agentree tab rename TAB NAME
  agentree tab close TAB
  agentree diff [working|staged|base|REF] open a diff in its own tab
  agentree notify MESSAGE... [--title T]  a desktop notification for the user
  agentree status [--json]                every worktree and its agent's status
  agentree worktree new --repo OWNER/NAME|PATH --branch NAME [--base REF]
                                          create (or adopt) a worktree exactly
                                          as the app's "add worktree" does —
                                          --repo names a repo already known to
                                          agentree, one not yet cloned (fetched
                                          with gh), or a local path to a repo;
                                          prints the worktree's id
  agentree skill install|uninstall|show   the Claude Code skill that teaches
                                          agents all this (~/.claude/skills)

TAB is a tab's index or name. --session S acts on another tmux session.
Any command accepts --help to print this instead of running.

Examples (an agent running a dev server beside itself):
  agentree tab new --name dev -- npm run dev
  agentree tab read dev --lines 30
  agentree tab send dev --key C-c

Example (spinning up an agent in another repo's worktree):
  id=$(agentree worktree new --repo owner/other-repo --branch agent/task)
  agentree tab new --worktree "$id" --repo owner/other-repo --name claude \\
    --select -- claude "do the thing"
`;

class CliError extends Error {}

interface Args {
  positional: string[];
  flags: Map<string, string[]>;
  /** Everything after `--`. */
  rest: string[];
}

/** Flags that take a value (the rest are switches). */
const VALUED = new Set(["name", "cwd", "lines", "key", "title", "session", "worktree", "repo", "branch", "base"]);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") return { positional, flags, rest: argv.slice(i + 1) };
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) add(name, a.slice(eq + 1));
      else if (VALUED.has(name)) {
        const v = argv[++i];
        if (v === undefined) throw new CliError(`--${name} needs a value`);
        add(name, v);
      } else add(name, "");
    } else positional.push(a);
  }
  return { positional, flags, rest: [] };
}

const flag = (a: Args, name: string) => a.flags.get(name)?.at(-1);
const has = (a: Args, name: string) => a.flags.has(name);

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const stdio: Io = {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
};

/** Run a CLI command; returns the exit code. */
export async function runCli(argv: string[], io: Io = stdio): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (has(args, "help") || has(args, "h")) {
      io.out(HELP);
      return 0;
    }
    const [command, ...rest] = args.positional;
    switch (command) {
      case undefined:
      case "help":
        io.out(HELP);
        return 0;
      case "tabs":
        return await tabCommand({ ...args, positional: ["list", ...rest] }, io);
      case "tab":
        return await tabCommand({ ...args, positional: rest }, io);
      case "diff":
        return await diff({ ...args, positional: rest }, io);
      case "notify":
        return notifyUser({ ...args, positional: rest }, io);
      case "status":
        return await status(args, io);
      case "skill":
        return skill({ ...args, positional: rest }, io);
      case "worktree":
        return await worktreeCommand({ ...args, positional: rest }, io);
      default:
        throw new CliError(`unknown command "${command}" — see agentree --help`);
    }
  } catch (err) {
    io.err(`agentree: ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof CliError ? 2 : 1;
  }
}

/** The tmux session to act on: --session, else the agentree terminal we're in. */
function currentSession(args: Args): string {
  const session = flag(args, "session") || process.env.AGENTREE_SESSION;
  if (!session) {
    throw new CliError("not inside an agentree terminal ($AGENTREE_SESSION isn't set) — pass --session");
  }
  return session;
}

async function findTab(session: string, ref: string | undefined): Promise<WindowInfo> {
  if (!ref) throw new CliError("which tab? give its index or name");
  const tabs = await tmuxOn().listWindows(session);
  if (tabs.length === 0) throw new CliError(`no tmux session "${session}"`);
  const tab = (/^\d+$/.test(ref) && tabs.find((t) => t.index === Number(ref))) || tabs.find((t) => t.name === ref);
  if (!tab) throw new CliError(`no tab "${ref}" — tabs: ${tabs.map((t) => `${t.index}:${t.name}`).join(", ")}`);
  return tab;
}

/**
 * The tmux session and cwd a repo's worktree id resolves to, across every
 * known repo (or just `repoArg`'s, to disambiguate an id that collides).
 */
function findWorktreeSession(
  state: State,
  worktreeId: string,
  repoArg: string | undefined,
): { session: string; path: string }[] {
  const matches: { session: string; path: string }[] = [];
  for (const repo of state.repos) {
    if (repoArg && repo.nameWithOwner !== repoArg) continue;
    const entries = [{ id: "main", path: repo.root }, ...repo.worktrees.map((w) => ({ id: w.id, path: w.path }))];
    const e = entries.find((e) => e.id === worktreeId);
    if (e) matches.push({ session: sessionName(repo.nameWithOwner, e.id), path: e.path });
  }
  return matches;
}

/**
 * The tmux session to act on: `--worktree` (with `--repo` to disambiguate,
 * starting its session if it isn't running yet), else `--session`/the
 * agentree terminal we're in.
 */
async function resolveSession(args: Args, tmux: Tmux): Promise<string> {
  const worktreeId = flag(args, "worktree");
  if (!worktreeId) return currentSession(args);
  const repoArg = flag(args, "repo");
  const matches = findWorktreeSession(loadState(), worktreeId, repoArg);
  if (matches.length === 0) {
    throw new CliError(`no worktree "${worktreeId}"${repoArg ? ` in ${repoArg}` : ""} — see agentree status`);
  }
  if (matches.length > 1) {
    throw new CliError(`worktree "${worktreeId}" exists in more than one repo — add --repo to pick one`);
  }
  const { session, path } = matches[0]!;
  if (!(await tmux.hasSession(session))) await tmux.newSession(session, path);
  return session;
}

async function tabCommand(args: Args, io: Io): Promise<number> {
  const tmux = tmuxOn();
  const session = await resolveSession(args, tmux);
  const [sub, ref, ...words] = args.positional;
  switch (sub) {
    case "list": {
      const tabs = await tmux.listWindows(session);
      if (tabs.length === 0) throw new CliError(`no tmux session "${session}"`);
      if (has(args, "json")) io.out(JSON.stringify(tabs));
      else
        for (const t of tabs)
          io.out(`${t.index}\t${t.name}${t.active ? "\t(active)" : ""}${t.panes > 1 ? `\t${t.panes} panes` : ""}`);
      return 0;
    }
    case "new": {
      const name = flag(args, "name");
      const tabs = await tmux.listWindows(session);
      if (tabs.length === 0) throw new CliError(`no tmux session "${session}"`);
      // A second "dev" tab would be a second dev server: say so instead.
      const clash = name && tabs.find((t) => t.name === name);
      if (clash)
        throw new CliError(`a tab named "${name}" is already open (${clash.index}) — use it, or close it first`);
      const index = await tmux.openTab(session, { name, cwd: flag(args, "cwd"), select: has(args, "select") });
      if (args.rest.length > 0) await tmux.sendText(`${session}:${index}`, shellJoin(args.rest));
      io.out(has(args, "json") ? JSON.stringify({ index, name: name ?? null }) : String(index));
      return 0;
    }
    case "read": {
      const tab = await findTab(session, ref);
      const lines = Number(flag(args, "lines") ?? 50);
      if (!Number.isFinite(lines) || lines < 1) throw new CliError("--lines needs a positive number");
      io.out(await tmux.capturePane(`${session}:${tab.index}`, lines));
      return 0;
    }
    case "send": {
      const tab = await findTab(session, ref);
      const target = `${session}:${tab.index}`;
      const keys = args.flags.get("key") ?? [];
      const text = [...words, ...args.rest].join(" ");
      if (keys.length === 0 && !text) throw new CliError("nothing to send — give TEXT or --key");
      if (text) await tmux.sendText(target, text, !has(args, "no-enter"));
      if (keys.length > 0) await tmux.sendKeys(target, ...keys);
      return 0;
    }
    case "select": {
      const tab = await findTab(session, ref);
      await tmux.selectWindow(session, tab.index);
      return 0;
    }
    case "rename": {
      const tab = await findTab(session, ref);
      const name = words.join(" ").trim();
      if (!name) throw new CliError("rename to what? give a NAME");
      await tmux.renameWindow(session, tab.index, name);
      return 0;
    }
    case "close": {
      const tab = await findTab(session, ref);
      const tabs = await tmux.listWindows(session);
      // The last tab going would take the session — and the app's terminal — with it.
      if (tabs.length <= 1) throw new CliError("that's the only tab; it stays");
      await tmux.killWindow(session, tab.index);
      return 0;
    }
    default:
      throw new CliError(`tab ${sub ?? ""}: expected list, new, read, send, select, rename or close`);
  }
}

async function diff(args: Args, io: Io): Promise<number> {
  const session = currentSession(args);
  const tmux = tmuxOn();
  const cwd = await tmux.sessionPath(session);
  if (!cwd) throw new CliError(`no tmux session "${session}"`);
  const what = args.positional[0] ?? "working";
  const target: DiffTarget = what === "working" || what === "staged" || what === "base" ? what : "ref";
  const arg = target === "base" ? await baseRef(cwd) : target === "ref" ? what : undefined;
  const viewer = resolveViewer(loadState().ui?.diffViewer, availableViewers());
  await tmux.newWindowCmd(session, cwd, diffCommand(viewer, target, arg ?? undefined), "diff");
  io.out(`diff (${what}) opened in ${viewer.label}`);
  return 0;
}

function skill(args: Args, io: Io): number {
  switch (args.positional[0] ?? "show") {
    case "install":
      io.out(`installed: ${installSkill()}`);
      return 0;
    case "uninstall":
      io.out(uninstallSkill() ? `removed: ${skillPath()}` : "it wasn't installed");
      return 0;
    case "show":
      io.out(`${skillPath()} — ${skillState()}\n`);
      io.out(SKILL_TEXT);
      return 0;
    default:
      throw new CliError("skill: expected install, uninstall or show");
  }
}

async function worktreeCommand(args: Args, io: Io): Promise<number> {
  const [sub] = args.positional;
  switch (sub) {
    case "new":
      return await worktreeNew(args, io);
    default:
      throw new CliError(`worktree ${sub ?? ""}: expected new`);
  }
}

/** A repo record: enough to create/register a worktree under it. */
type RepoMeta = Omit<StoredRepo, "worktrees">;

/** Whether a string looks like `owner/name` rather than a filesystem path. */
function looksLikeNameWithOwner(s: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(s);
}

/** `owner/name` parsed out of a git remote URL (ssh or https), if it has one. */
function nameWithOwnerFromUrl(url: string): string | undefined {
  return url.match(/[/:]([^/:]+\/[^/]+?)(\.git)?$/)?.[1];
}

/** The repo meta for an on-disk git repo (main worktree or any of its worktrees). */
async function repoMetaForPath(state: State, inputPath: string): Promise<RepoMeta> {
  const common = await run(["git", "rev-parse", "--git-common-dir"], { cwd: inputPath });
  if (common.code !== 0) throw new CliError(`--repo "${inputPath}": not a git repository`);
  const gitDir = resolve(inputPath, common.stdout.trim());
  const root = basename(gitDir) === ".git" ? dirname(gitDir) : gitDir;

  const canon = canonicalPath(root);
  const existing = state.repos.find((r) => canonicalPath(r.root) === canon);
  if (existing) return existing;

  const remote = await run(["git", "config", "--get", "remote.origin.url"], { cwd: root });
  const fromRemote = remote.code === 0 ? nameWithOwnerFromUrl(remote.stdout.trim()) : undefined;
  const name = fromRemote?.split("/")[1] ?? basename(root);
  return { nameWithOwner: fromRemote ?? name, name, root };
}

/**
 * The repo `--repo` names: a path to a git repo already on disk (its root
 * adopted or registered), else `owner/name` — a repo agentree already knows,
 * or one cloned (via `gh`) into the usual workspace location if it isn't on
 * disk yet, exactly like the app's "add worktree" picker.
 */
async function resolveRepo(state: State, repoArg: string): Promise<RepoMeta> {
  if (existsSync(resolve(repoArg))) return repoMetaForPath(state, resolve(repoArg));
  if (!looksLikeNameWithOwner(repoArg)) {
    throw new CliError(`--repo "${repoArg}": not a path on disk, and not "owner/name"`);
  }
  const existing = findRepo(state, repoArg);
  const name = repoArg.split("/")[1]!;
  const root = existing?.root ?? repoDir(name);
  if (!existsSync(root)) await clone(repoArg, root);
  return { nameWithOwner: repoArg, name, root };
}

async function worktreeNew(args: Args, io: Io): Promise<number> {
  const repoArg = flag(args, "repo");
  const branch = flag(args, "branch");
  if (!repoArg) throw new CliError("worktree new: --repo needed — owner/name or a path");
  if (!branch) throw new CliError("worktree new: --branch needed");
  const base = flag(args, "base");

  const state = loadState();
  const meta = await resolveRepo(state, repoArg);

  // A worktree already on this branch is adopted (registered if it wasn't) rather than duplicated.
  const current = await listWorktrees(meta.root);
  const same = current.find((w) => w.branch === branch);
  if (same) {
    const isMain = canonicalPath(same.path) === canonicalPath(meta.root);
    const id = isMain ? "main" : sanitizeBranchForPath(branch);
    if (isMain) {
      upsertRepo(state, meta);
      await saveState(state);
    } else {
      await addManagedWorktree(state, meta, {
        id,
        branch,
        name: branchLeaf(branch),
        path: same.path,
        createdAt: new Date().toISOString(),
      });
    }
    io.out(has(args, "json") ? JSON.stringify({ id, path: same.path, repo: meta.nameWithOwner }) : id);
    return 0;
  }

  const path = worktreePath(meta.root, branch);
  mkdirSync(dirname(path), { recursive: true });
  const exists = await localBranchExists(meta.root, branch);
  await addWorktree(meta.root, path, branch, { newBranch: !exists, base });

  const id = sanitizeBranchForPath(branch);
  await addManagedWorktree(state, meta, {
    id,
    branch,
    name: branchLeaf(branch),
    path,
    createdAt: new Date().toISOString(),
  });
  io.out(has(args, "json") ? JSON.stringify({ id, path, repo: meta.nameWithOwner }) : id);
  return 0;
}

/** The worktree a session belongs to, from state: its name and project. */
function whose(session: string): { name: string; project: string } | undefined {
  const state = loadState();
  for (const repo of state.repos) {
    for (const id of ["main", ...repo.worktrees.map((w) => w.id)]) {
      if (sessionName(repo.nameWithOwner, id) !== session) continue;
      const wt = repo.worktrees.find((w) => w.id === id);
      return { name: repo.labels?.[id] ?? wt?.name ?? id, project: repo.name };
    }
  }
  for (const host of state.hosts ?? []) {
    const dir = host.dirs.find((d) => sessionName(`ssh:${host.host}`, d.id) === session);
    if (dir) return { name: host.labels?.[dir.id] ?? dir.id, project: host.host };
  }
  return undefined;
}

function notifyUser(args: Args, io: Io): number {
  const message = [...args.positional, ...args.rest].join(" ").trim();
  if (!message) throw new CliError("notify what? give a MESSAGE");
  const session = flag(args, "session") || process.env.AGENTREE_SESSION;
  const where = session ? whose(session) : undefined;
  notify(flag(args, "title") ?? (where ? `${where.name} — ${where.project}` : "agentree"), message);
  io.out("sent");
  return 0;
}

async function status(args: Args, io: Io): Promise<number> {
  const state = loadState();
  const reports = await readAgentStatuses();
  const here = process.env.AGENTREE_SESSION;
  const rows: {
    project: string;
    worktree: string;
    id: string;
    branch: string | null;
    path: string;
    agent: string;
    session: string;
    here: boolean;
  }[] = [];
  for (const repo of state.repos) {
    const entries = [
      { id: "main", name: "main", branch: null as string | null, path: repo.root },
      ...repo.worktrees.map((w) => ({ id: w.id, name: w.name, branch: w.branch, path: w.path })),
    ];
    for (const e of entries) {
      const session = sessionName(repo.nameWithOwner, e.id);
      rows.push({
        project: repo.name,
        worktree: repo.labels?.[e.id] ?? e.name,
        id: e.id,
        branch: e.branch,
        path: e.path,
        agent: reports.get(session)?.state ?? "none",
        session,
        here: session === here,
      });
    }
  }
  for (const host of state.hosts ?? []) {
    for (const d of host.dirs) {
      const session = sessionName(`ssh:${host.host}`, d.id);
      rows.push({
        project: host.host,
        worktree: host.labels?.[d.id] ?? d.id,
        id: d.id,
        branch: null,
        path: `${host.host}:${d.path}`,
        agent: "unknown (ssh)",
        session,
        here: session === here,
      });
    }
  }
  if (has(args, "json")) io.out(JSON.stringify(rows));
  else {
    for (const r of rows) {
      io.out(`${r.here ? "*" : " "} ${r.project}/${r.worktree}\t${r.agent}${r.branch ? `\t${r.branch}` : ""}`);
    }
  }
  return 0;
}
