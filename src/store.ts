/**
 * Persistent store for app-managed repos + worktrees.
 *
 * Only stable metadata is persisted (identity + paths). Volatile git status is
 * computed at runtime. Loading is synchronous; every mutation writes atomically.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stateFilePath, workspaceRoot, branchLeaf } from "./config";
import { ignoreWorktreesDir, listWorktrees } from "./services/git";
import type { Project, Worktree } from "./data/model";
import { displayPath } from "./services/ssh";
import { DIFF_VIEWERS, type DiffViewerId } from "./services/diff";

export interface StoredWorktree {
  id: string;
  branch: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface StoredRepo {
  nameWithOwner: string;
  name: string;
  root: string;
  defaultBranch?: string;
  worktrees: StoredWorktree[];
  /**
   * Your own names for worktrees, shown in the sidebar instead of the branch's
   * leaf name, by worktree id ("main" included). Display only: the branch and
   * the worktree on disk keep their names.
   */
  labels?: Record<string, string>;
}

/** A directory on an SSH host, opened as a terminal there. */
export interface StoredRemoteDir {
  id: string;
  /** Absolute path on the host. */
  path: string;
  createdAt: string;
}

/** An SSH project: a host and the directories on it you open terminals in. */
export interface StoredHost {
  /** What `ssh` connects to: a ~/.ssh/config alias, `user@host`, or `ssh://…`. */
  host: string;
  /** The remote $HOME, to show paths under it as `~/…`. */
  home?: string;
  /** Logging in takes a password (or a key passphrase) — asked for, never stored. */
  needsPassword?: boolean;
  dirs: StoredRemoteDir[];
  /** Your labels for its directories, by id (see StoredRepo.labels). */
  labels?: Record<string, string>;
}

/** App preferences that aren't about repos, e.g. layout. */
export interface UiState {
  /** Sidebar width the user dragged/resized to; omitted = default. */
  sidebarWidth?: number;
  /** The sidebar was hidden (`b`); omitted = shown. */
  sidebarHidden?: boolean;
  /** The PR panel was switched off (`p`); omitted = shown. */
  prPanelHidden?: boolean;
  /** PR panel width the user dragged to; omitted = default. */
  prPanelWidth?: number;
  /** The merge method used last (`m` in the PR panel), offered first next time. */
  mergeMethod?: "squash" | "merge" | "rebase";
  /** PR panel sections folded away (by name, e.g. "description"). */
  prPanelCollapsed?: string[];
  /** The diff viewer picked in the diff picker (`v`); omitted = the first installed. */
  diffViewer?: DiffViewerId;
}

export interface State {
  version: 1;
  workspaceRoot: string;
  repos: StoredRepo[];
  /** SSH projects, listed after the repos. */
  hosts?: StoredHost[];
  ui?: UiState;
}

/** Keep only well-formed ui fields from a parsed state file. */
function sanitizeUi(raw: unknown): UiState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { sidebarWidth, sidebarHidden, prPanelHidden, prPanelWidth, mergeMethod, prPanelCollapsed, diffViewer } =
    raw as Record<string, unknown>;
  const width = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
  const ui: UiState = {};
  if (width(sidebarWidth)) ui.sidebarWidth = width(sidebarWidth);
  if (width(prPanelWidth)) ui.prPanelWidth = width(prPanelWidth);
  if (prPanelHidden === true) ui.prPanelHidden = true;
  if (sidebarHidden === true) ui.sidebarHidden = true;
  if (mergeMethod === "squash" || mergeMethod === "merge" || mergeMethod === "rebase") {
    ui.mergeMethod = mergeMethod;
  }
  if (typeof diffViewer === "string" && DIFF_VIEWERS.some((v) => v.id === diffViewer)) {
    ui.diffViewer = diffViewer as DiffViewerId;
  }
  if (Array.isArray(prPanelCollapsed)) {
    const names = prPanelCollapsed.filter((s): s is string => typeof s === "string");
    if (names.length > 0) ui.prPanelCollapsed = names;
  }
  return Object.keys(ui).length > 0 ? ui : undefined;
}

/** Keep only well-formed SSH hosts (and their directories) from a parsed state file. */
function sanitizeHosts(raw: unknown): StoredHost[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const hosts: StoredHost[] = [];
  for (const h of raw) {
    if (!h || typeof h !== "object" || typeof h.host !== "string" || !h.host) continue;
    const dirs = (Array.isArray(h.dirs) ? h.dirs : []).filter(
      (d: unknown): d is StoredRemoteDir =>
        !!d && typeof (d as StoredRemoteDir).id === "string" && typeof (d as StoredRemoteDir).path === "string",
    );
    hosts.push({
      host: h.host,
      ...(typeof h.home === "string" && { home: h.home }),
      ...(h.needsPassword === true && { needsPassword: true }),
      dirs,
      ...(h.labels && typeof h.labels === "object" && { labels: h.labels }),
    });
  }
  return hosts.length > 0 ? hosts : undefined;
}

function emptyState(): State {
  return { version: 1, workspaceRoot: workspaceRoot(), repos: [] };
}

/** Read state.json synchronously. Missing/corrupt → empty state, never throws. */
export function loadState(): State {
  try {
    const raw = readFileSync(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw) as State;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.repos)) {
      return emptyState();
    }
    const ui = sanitizeUi(parsed.ui);
    const hosts = sanitizeHosts(parsed.hosts);
    return {
      version: 1,
      workspaceRoot: workspaceRoot(),
      repos: parsed.repos,
      ...(hosts && { hosts }),
      ...(ui && { ui }),
    };
  } catch {
    return emptyState();
  }
}

/** Atomically persist state (tmp file + rename). */
export async function saveState(state: State): Promise<void> {
  const path = stateFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Find (or return undefined) a repo by nameWithOwner. */
export function findRepo(state: State, nameWithOwner: string): StoredRepo | undefined {
  return state.repos.find((r) => r.nameWithOwner === nameWithOwner);
}

/** Add or update a repo record (without touching its worktrees). */
export function upsertRepo(state: State, meta: Omit<StoredRepo, "worktrees">): StoredRepo {
  let repo = findRepo(state, meta.nameWithOwner);
  if (repo) {
    repo.name = meta.name;
    repo.root = meta.root;
    if (meta.defaultBranch) repo.defaultBranch = meta.defaultBranch;
  } else {
    repo = { ...meta, worktrees: [] };
    state.repos.push(repo);
  }
  return repo;
}

/** Register a worktree under a repo (dedup by id) and persist. */
export async function addManagedWorktree(
  state: State,
  meta: Omit<StoredRepo, "worktrees">,
  wt: StoredWorktree,
): Promise<void> {
  const repo = upsertRepo(state, meta);
  if (!repo.worktrees.some((w) => w.id === wt.id)) {
    repo.worktrees.push(wt);
  }
  await saveState(state);
}

/** Drop a worktree from a repo's managed list (not from disk) and persist. */
export async function removeManagedWorktree(state: State, nameWithOwner: string, worktreeId: string): Promise<void> {
  const repo = findRepo(state, nameWithOwner);
  if (!repo) return;
  repo.worktrees = repo.worktrees.filter((w) => w.id !== worktreeId);
  dropLabel(repo, worktreeId); // a new worktree reusing the id starts unlabelled
  await saveState(state);
}

/** Longest label kept; the sidebar truncates long ones anyway. */
export const MAX_LABEL_LENGTH = 48;

/**
 * Give a worktree a display label, or clear it (`undefined` / blank) to show
 * the branch name again. Persists. Returns the label as stored.
 */
export async function setWorktreeLabel(
  state: State,
  nameWithOwner: string,
  worktreeId: string,
  label: string | undefined,
): Promise<string | undefined> {
  // A repo's worktree, or an SSH project's directory.
  const host = hostOfProject(nameWithOwner);
  const owner = host ? findHost(state, host) : findRepo(state, nameWithOwner);
  if (!owner) return undefined;
  const clean = normalizeLabel(label);
  if (clean) owner.labels = { ...owner.labels, [worktreeId]: clean };
  else dropLabel(owner, worktreeId);
  await saveState(state);
  return clean;
}

/** Collapse whitespace, trim and cap a label; blank → undefined. */
export function normalizeLabel(label: string | undefined): string | undefined {
  const clean = Array.from((label ?? "").replace(/\s+/g, " ").trim())
    .slice(0, MAX_LABEL_LENGTH)
    .join("")
    .trim();
  return clean || undefined;
}

function dropLabel(repo: { labels?: Record<string, string> }, worktreeId: string) {
  if (!repo.labels || !(worktreeId in repo.labels)) return;
  const { [worktreeId]: _, ...rest } = repo.labels;
  if (Object.keys(rest).length > 0) repo.labels = rest;
  else delete repo.labels;
}

/** A repo's (or host's) label for a worktree, if it has a well-formed one. */
function labelFor(repo: { labels?: Record<string, unknown> }, worktreeId: string): string | undefined {
  const label = repo.labels?.[worktreeId];
  return typeof label === "string" ? normalizeLabel(label) : undefined;
}

// --- SSH projects ---

/** An SSH project's id: its host, prefixed so it can't clash with a repo's `owner/name`. */
export function sshProjectId(host: string): string {
  return `ssh:${host}`;
}

/** The host of an SSH project id, or undefined for a repo. */
export function hostOfProject(projectId: string): string | undefined {
  return projectId.startsWith("ssh:") ? projectId.slice(4) : undefined;
}

export function findHost(state: State, host: string): StoredHost | undefined {
  return state.hosts?.find((h) => h.host === host);
}

/**
 * Add a directory on `host` (checked with probeRemoteDir first), adding the
 * host itself if it's new. A directory already listed isn't added twice.
 * Persists; returns the directory's id.
 */
export async function addRemoteDir(
  state: State,
  host: string,
  dir: { path: string; home?: string },
  opts: { needsPassword?: boolean } = {},
): Promise<string> {
  let record = findHost(state, host);
  if (!record) {
    record = { host, dirs: [] };
    state.hosts = [...(state.hosts ?? []), record];
  }
  if (dir.home) record.home = dir.home;
  if (opts.needsPassword) record.needsPassword = true;
  const existing = record.dirs.find((d) => d.path === dir.path);
  if (existing) {
    await saveState(state);
    return existing.id;
  }
  const base = remoteDirName(dir.path, record.home).replace(/[^A-Za-z0-9._-]+/g, "-") || "dir";
  let id = base;
  for (let n = 1; record.dirs.some((d) => d.id === id); n++) id = `${base}-${n}`;
  record.dirs.push({ id, path: dir.path, createdAt: new Date().toISOString() });
  await saveState(state);
  return id;
}

/** Forget a directory on a host (nothing on the host is touched). Persists. */
export async function removeRemoteDir(state: State, host: string, id: string): Promise<void> {
  const record = findHost(state, host);
  if (!record) return;
  record.dirs = record.dirs.filter((d) => d.id !== id);
  dropLabel(record, id);
  await saveState(state);
}

/** Forget a host and its directories. Persists. */
export async function removeHost(state: State, host: string): Promise<void> {
  state.hosts = (state.hosts ?? []).filter((h) => h.host !== host);
  if (state.hosts.length === 0) delete state.hosts;
  await saveState(state);
}

/** A remote directory's short name: its last segment, or `~` for the home directory. */
function remoteDirName(path: string, home?: string): string {
  const shown = displayPath(path, home);
  if (shown === "~" || shown === "/") return shown;
  return shown.split("/").filter(Boolean).pop() ?? shown;
}

/** The UI project for a host: its directories, which need no reconciling with git. */
function hostProject(record: StoredHost): Project {
  return {
    id: sshProjectId(record.host),
    name: record.host,
    root: record.host,
    ssh: {
      host: record.host,
      ...(record.needsPassword && { needsPassword: true }),
      ...(record.home && { home: record.home }),
    },
    worktrees: record.dirs.map((d) => {
      const label = labelFor(record, d.id);
      return toUiWorktree(
        { id: d.id, name: remoteDirName(d.path, record.home), branch: "", path: d.path },
        {
          host: record.host,
          subtitle: displayPath(d.path, record.home),
          ...(record.needsPassword && { hostNeedsPassword: true }),
          ...(record.home && { hostHome: record.home }),
          ...(label && { label }),
        },
      );
    }),
  };
}

function toUiWorktree(
  w: Pick<StoredWorktree, "id" | "name" | "branch" | "path">,
  extra: Partial<Worktree> = {},
): Worktree {
  return {
    id: w.id,
    name: w.name,
    branch: w.branch,
    path: w.path,
    dirty: false,
    changed: 0,
    added: 0,
    removed: 0,
    ahead: 0,
    behind: 0,
    agent: "none",
    ...extra,
  };
}

/**
 * Build the UI `Project[]` from persisted state, reconciled against the actual
 * `git worktree list` for each repo. Self-heals state (adopts on-disk worktrees,
 * marks vanished ones) and persists if anything changed.
 */
export async function reconcile(state: State): Promise<Project[]> {
  let changed = false;
  const projects: Project[] = [];

  for (const repo of state.repos) {
    const worktrees: Worktree[] = [];
    const label = (id: string) => {
      const l = labelFor(repo, id);
      return l ? { label: l } : {};
    };

    if (!existsSync(repo.root)) {
      // Clone dir gone — surface everything as missing.
      for (const w of repo.worktrees) {
        worktrees.push(toUiWorktree(w, { missing: true, ...label(w.id) }));
      }
      projects.push({ id: repo.nameWithOwner, name: repo.name, root: repo.root, worktrees });
      continue;
    }

    ignoreWorktreesDir(repo.root);
    let onDisk: Awaited<ReturnType<typeof listWorktrees>> = [];
    try {
      onDisk = await listWorktrees(repo.root);
    } catch {
      onDisk = [];
    }

    const rootResolved = resolve(repo.root);
    const byPath = new Map(onDisk.map((w) => [resolve(w.path), w]));
    const matchedPaths = new Set<string>();

    // 1. Main working copy (git entry at the repo root).
    const main = onDisk.find((w) => resolve(w.path) === rootResolved);
    if (main) {
      matchedPaths.add(rootResolved);
      worktrees.push(
        toUiWorktree(
          {
            id: "main",
            name: main.branch ? branchLeaf(main.branch) : "main",
            branch: main.branch ?? "(detached)",
            path: repo.root,
          },
          label("main"),
        ),
      );
    }

    // 2. Stored worktrees: present on disk → normal; else → missing. A path
    // git still tracks (e.g. its directory was `rm -rf`'d rather than removed
    // with `git worktree remove`) counts as matched either way — otherwise
    // step 3 below would treat it as unclaimed and adopt a duplicate for it.
    for (const w of repo.worktrees) {
      const key = resolve(w.path);
      if (byPath.has(key)) matchedPaths.add(key);
      if (byPath.has(key) && existsSync(w.path)) {
        worktrees.push(toUiWorktree(w, label(w.id)));
      } else {
        worktrees.push(toUiWorktree(w, { missing: true, ...label(w.id) }));
      }
    }

    // 3. On-disk worktrees not in state (and not the main copy) → adopt.
    for (const w of onDisk) {
      const key = resolve(w.path);
      if (matchedPaths.has(key)) continue;
      const branch = w.branch ?? "(detached)";
      const adopted: StoredWorktree = {
        id: idFromPath(w.path, repo),
        branch,
        name: w.branch ? branchLeaf(w.branch) : "detached",
        path: w.path,
        createdAt: "",
      };
      repo.worktrees.push(adopted);
      changed = true;
      worktrees.push(toUiWorktree(adopted));
    }

    projects.push({ id: repo.nameWithOwner, name: repo.name, root: repo.root, worktrees });
  }

  for (const record of state.hosts ?? []) projects.push(hostProject(record));

  if (changed) await saveState(state);
  return projects;
}

function idFromPath(path: string, repo: StoredRepo): string {
  const base = path.split("/").pop() || "worktree";
  let id = base;
  let n = 1;
  while (repo.worktrees.some((w) => w.id === id)) id = `${base}-${n++}`;
  return id;
}
