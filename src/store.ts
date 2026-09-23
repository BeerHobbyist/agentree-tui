/**
 * Persistent store for app-managed repos + worktrees.
 *
 * Only stable metadata is persisted (identity + paths). Volatile git status is
 * computed at runtime. Loading is synchronous; every mutation writes atomically.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { stateFilePath, workspaceRoot, branchLeaf } from "./config";
import { ignoreWorktreesDir, listWorktrees } from "./services/git";
import type { Project, Worktree } from "./data/model";

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
}

/** App preferences that aren't about repos, e.g. layout. */
export interface UiState {
  /** Sidebar width the user dragged/resized to; omitted = default. */
  sidebarWidth?: number;
}

export interface State {
  version: 1;
  workspaceRoot: string;
  repos: StoredRepo[];
  ui?: UiState;
}

/** Keep only well-formed ui fields from a parsed state file. */
function sanitizeUi(raw: unknown): UiState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { sidebarWidth } = raw as { sidebarWidth?: unknown };
  if (typeof sidebarWidth === "number" && Number.isFinite(sidebarWidth) && sidebarWidth > 0) {
    return { sidebarWidth: Math.round(sidebarWidth) };
  }
  return undefined;
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
    return {
      version: 1,
      workspaceRoot: workspaceRoot(),
      repos: parsed.repos,
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
export function findRepo(
  state: State,
  nameWithOwner: string,
): StoredRepo | undefined {
  return state.repos.find((r) => r.nameWithOwner === nameWithOwner);
}

/** Add or update a repo record (without touching its worktrees). */
export function upsertRepo(
  state: State,
  meta: Omit<StoredRepo, "worktrees">,
): StoredRepo {
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
export async function removeManagedWorktree(
  state: State,
  nameWithOwner: string,
  worktreeId: string,
): Promise<void> {
  const repo = findRepo(state, nameWithOwner);
  if (!repo) return;
  repo.worktrees = repo.worktrees.filter((w) => w.id !== worktreeId);
  await saveState(state);
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

    if (!existsSync(repo.root)) {
      // Clone dir gone — surface everything as missing.
      for (const w of repo.worktrees) {
        worktrees.push(toUiWorktree(w, { missing: true }));
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
        toUiWorktree({
          id: "main",
          name: main.branch ? branchLeaf(main.branch) : "main",
          branch: main.branch ?? "(detached)",
          path: repo.root,
        }),
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
        worktrees.push(toUiWorktree(w));
      } else {
        worktrees.push(toUiWorktree(w, { missing: true }));
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
