import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TextAttributes } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "../theme";
import type { OpenPr, Project, RepoSummary } from "../data/model";
import {
  branchLeaf,
  repoDir,
  sanitizeBranchForPath,
  worktreePath,
} from "../config";
import {
  clone,
  fetchRepoPage,
  getCachedRepos,
  listOpenPrs,
  setRepoCache,
} from "../services/gh";
import {
  addWorktree,
  fetchPrBranch,
  ignoreWorktreesDir,
  listWorktrees,
  localBranchExists,
} from "../services/git";
import {
  addManagedWorktree,
  findRepo,
  reconcile,
  saveState,
  upsertRepo,
  type State,
} from "../store";
import { existsSync } from "node:fs";

type Phase =
  | "repoLoading"
  | "repoList"
  | "repoError"
  | "cloning"
  | "cloneError"
  | "actions"
  | "branchInput"
  | "creating"
  | "createError";

/** A worktree already present on disk for the selected repo. */
interface ExistingWorktree {
  id: string;
  name: string;
  branch: string;
  path: string;
  isMain: boolean;
}

export interface Selection {
  repoId: string;
  worktreeId: string;
}

/** A repo already known to the app, to skip the repo-picker step. */
export interface PreselectRepo {
  nameWithOwner: string;
  name: string;
  root: string;
}

interface AddWorktreeModalProps {
  state: State;
  /** When set, jump straight to the worktree actions for this repo. */
  preselect?: PreselectRepo | null;
  onClose: () => void;
  onApplied: (projects: Project[], selection: Selection) => void;
}

const MAX_LIST_ROWS = 10;

export function AddWorktreeModal({
  state,
  preselect,
  onClose,
  onApplied,
}: AddWorktreeModalProps) {
  const theme = useTheme();
  const [phase, setPhase] = useState<Phase>(
    preselect ? "actions" : "repoLoading",
  );
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [root, setRoot] = useState<string>("");
  const [existing, setExisting] = useState<ExistingWorktree[]>([]);
  const [prs, setPrs] = useState<OpenPr[]>([]);
  const [pendingPr, setPendingPr] = useState<OpenPr | null>(null);
  const [branch, setBranch] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // PRs that don't already have a worktree for their branch.
  const availablePrs = prs.filter(
    (pr) => !existing.some((w) => w.branch === pr.headRefName),
  );

  // Everything the keyboard handler needs, mirrored to refs (handler is global).
  const ref = useRef({
    phase,
    repos,
    query,
    index,
    repo,
    root,
    existing,
    prs: availablePrs,
    pendingPr,
    branch,
  });
  ref.current = {
    phase,
    repos,
    query,
    index,
    repo,
    root,
    existing,
    prs: availablePrs,
    pendingPr,
    branch,
  };

  const loadRepos = (force = false) => {
    // Instant when we already have the full list cached.
    const cached = getCachedRepos();
    if (cached && !force) {
      setRepos(cached);
      setIndex(0);
      setQuery("");
      setPhase("repoList");
      setLoadingMore(false);
      return;
    }

    // Otherwise stream pages: show page 1 fast, append the rest in background.
    setPhase("repoLoading");
    setLoadingMore(true);
    (async () => {
      let acc: RepoSummary[] = [];
      let page = 1;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let res;
        try {
          res = await fetchRepoPage(page);
        } catch (err) {
          if (!mounted.current) return;
          if (page === 1) {
            setErrorMsg(errText(err));
            setPhase("repoError");
          }
          break;
        }
        if (!mounted.current) return;
        acc = acc.concat(res.repos);
        setRepos(acc);
        if (page === 1) {
          setIndex(0);
          setQuery("");
          setPhase("repoList");
        }
        if (!res.hasMore) break;
        page++;
      }
      if (!mounted.current) return;
      setLoadingMore(false);
      setRepoCache(acc);
    })();
  };

  useEffect(() => {
    if (preselect) {
      setRepo({
        name: preselect.name,
        nameWithOwner: preselect.nameWithOwner,
        description: "",
        isPrivate: false,
        updatedAt: "",
        url: "",
      });
      setRoot(preselect.root);
      openActions(preselect.root, preselect.nameWithOwner);
    } else {
      loadRepos();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredRepos = (): RepoSummary[] => {
    const q = query.trim().toLowerCase();
    // No query → keep API order (most-recently-pushed first).
    if (!q) return repos;
    // Rank by match quality; ties keep pushed order (stable sort).
    return repos
      .map((r) => ({ r, s: relevance(q, r) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.r);
  };

  const buildExisting = async (repoRoot: string): Promise<ExistingWorktree[]> => {
    const wts = await listWorktrees(repoRoot);
    return wts.map((w) => {
      const isMain = resolve(w.path) === resolve(repoRoot);
      const br = w.branch ?? "(detached)";
      return {
        id: isMain ? "main" : sanitizeBranchForPath(br),
        name: isMain ? "main" : branchLeaf(br),
        branch: br,
        path: w.path,
        isMain,
      };
    });
  };

  const chooseRepo = (r: RepoSummary) => {
    const existingRepo = findRepo(state, r.nameWithOwner);
    const repoRoot = existingRepo?.root ?? repoDir(r.name);
    setRepo(r);
    setRoot(repoRoot);

    if (existsSync(repoRoot)) {
      openActions(repoRoot, r.nameWithOwner);
    } else {
      setPhase("cloning");
      clone(r.nameWithOwner, repoRoot).then(
        () => {
          if (!mounted.current) return;
          openActions(repoRoot, r.nameWithOwner);
        },
        (err) => {
          if (!mounted.current) return;
          setErrorMsg(errText(err));
          setPhase("cloneError");
        },
      );
    }
  };

  const openActions = (repoRoot: string, nameWithOwner: string) => {
    ignoreWorktreesDir(repoRoot);
    setPrs([]);
    buildExisting(repoRoot).then(
      (list) => {
        if (!mounted.current) return;
        setExisting(list);
        setIndex(0);
        setPhase("actions");
      },
      (err) => {
        if (!mounted.current) return;
        setErrorMsg(errText(err));
        setPhase("cloneError");
      },
    );
    // Best-effort: open PRs are an extra option, not required to use the modal.
    listOpenPrs(nameWithOwner).then((list) => {
      if (!mounted.current) return;
      setPrs(list);
    });
  };

  /** Persist + reconcile + hand the fresh projects and selection back to App. */
  const apply = async (selection: Selection) => {
    const projects = await reconcile(state);
    if (!mounted.current) return;
    onApplied(projects, selection);
  };

  const loadExisting = async (wt: ExistingWorktree) => {
    if (!repo) return;
    const meta = { nameWithOwner: repo.nameWithOwner, name: repo.name, root };
    if (wt.isMain) {
      upsertRepo(state, meta);
      await saveState(state);
    } else {
      await addManagedWorktree(state, meta, {
        id: wt.id,
        branch: wt.branch,
        name: wt.name,
        path: wt.path,
        createdAt: new Date().toISOString(),
      });
    }
    await apply({ repoId: repo.nameWithOwner, worktreeId: wt.id });
  };

  const createWorktree = (branchName: string) => {
    if (!repo) return;
    const name = branchName.trim();
    if (!name) return;
    setBranch(name);
    setPendingPr(null);
    setPhase("creating");

    (async () => {
      // If a worktree already exists on this branch, load it instead.
      const current = await listWorktrees(root);
      const same = current.find((w) => w.branch === name);
      if (same) {
        const isMain = resolve(same.path) === resolve(root);
        await loadExisting({
          id: isMain ? "main" : sanitizeBranchForPath(name),
          name: isMain ? "main" : branchLeaf(name),
          branch: name,
          path: same.path,
          isMain,
        });
        return;
      }

      const path = worktreePath(root, name);
      mkdirSync(dirname(path), { recursive: true });
      const exists = await localBranchExists(root, name);
      await addWorktree(root, path, name, { newBranch: !exists });

      const id = sanitizeBranchForPath(name);
      await addManagedWorktree(
        state,
        { nameWithOwner: repo.nameWithOwner, name: repo.name, root },
        {
          id,
          branch: name,
          name: branchLeaf(name),
          path,
          createdAt: new Date().toISOString(),
        },
      );
      await apply({ repoId: repo.nameWithOwner, worktreeId: id });
    })().catch((err) => {
      if (!mounted.current) return;
      setErrorMsg(errText(err));
      setPhase("createError");
    });
  };

  /** Create (or load) a worktree from an open PR, naming it after the PR's branch. */
  const createFromPr = (pr: OpenPr) => {
    if (!repo) return;
    const name = pr.headRefName;
    setBranch(name);
    setPendingPr(pr);
    setPhase("creating");

    (async () => {
      // If a worktree already exists on this branch, load it instead.
      const current = await listWorktrees(root);
      const same = current.find((w) => w.branch === name);
      if (same) {
        const isMain = resolve(same.path) === resolve(root);
        await loadExisting({
          id: isMain ? "main" : sanitizeBranchForPath(name),
          name: isMain ? "main" : branchLeaf(name),
          branch: name,
          path: same.path,
          isMain,
        });
        return;
      }

      await fetchPrBranch(root, pr.number, name);
      const path = worktreePath(root, name);
      mkdirSync(dirname(path), { recursive: true });
      await addWorktree(root, path, name, { newBranch: false });

      const id = sanitizeBranchForPath(name);
      await addManagedWorktree(
        state,
        { nameWithOwner: repo.nameWithOwner, name: repo.name, root },
        {
          id,
          branch: name,
          name: branchLeaf(name),
          path,
          createdAt: new Date().toISOString(),
        },
      );
      await apply({ repoId: repo.nameWithOwner, worktreeId: id });
    })().catch((err) => {
      if (!mounted.current) return;
      setErrorMsg(errText(err));
      setPhase("createError");
    });
  };

  useKeyboard((key) => {
    const s = ref.current;
    const name = key.name ?? "";

    // Escape is a universal back/cancel. With a preselected repo there's no
    // repo-picker to return to, so actions/cloneError close outright.
    if (name === "escape") {
      if (s.phase === "actions")
        return preselect ? onClose() : void setPhase("repoList");
      if (s.phase === "branchInput") return void setPhase("actions");
      if (s.phase === "cloneError")
        return preselect ? onClose() : void setPhase("repoList");
      if (s.phase === "createError")
        return void setPhase(s.pendingPr ? "actions" : "branchInput");
      return onClose();
    }

    switch (s.phase) {
      case "repoError": {
        if (name === "r") loadRepos(true);
        return;
      }
      case "repoList": {
        const list = filteredRepos();
        if (name === "down" || name === "j") {
          setIndex(Math.min(s.index + 1, Math.max(list.length - 1, 0)));
        } else if (name === "up" || name === "k") {
          setIndex(Math.max(s.index - 1, 0));
        } else if (name === "return") {
          const chosen = list[s.index];
          if (chosen) chooseRepo(chosen);
        } else if (name === "backspace") {
          setQuery(s.query.slice(0, -1));
          setIndex(0);
        } else if (isPrintable(name)) {
          setQuery(s.query + name);
          setIndex(0);
        }
        return;
      }
      case "actions": {
        const total = s.existing.length + s.prs.length + 1; // +1 for "create new"
        if (name === "down" || name === "j") {
          setIndex(Math.min(s.index + 1, total - 1));
        } else if (name === "up" || name === "k") {
          setIndex(Math.max(s.index - 1, 0));
        } else if (name === "return") {
          if (s.index === 0) {
            setBranch("");
            setPhase("branchInput");
          } else if (s.index <= s.existing.length) {
            const wt = s.existing[s.index - 1];
            if (wt) void loadExisting(wt);
          } else {
            const pr = s.prs[s.index - s.existing.length - 1];
            if (pr) createFromPr(pr);
          }
        }
        return;
      }
      case "branchInput": {
        if (name === "return") {
          createWorktree(s.branch);
        } else if (name === "backspace") {
          setBranch(s.branch.slice(0, -1));
        } else if (isBranchChar(name)) {
          setBranch(s.branch + name);
        }
        return;
      }
      case "cloneError": {
        if (name === "r" && s.repo) chooseRepo(s.repo);
        return;
      }
      case "createError": {
        if (name === "r") {
          if (s.pendingPr) createFromPr(s.pendingPr);
          else createWorktree(s.branch);
        }
        return;
      }
    }
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      alignItems="center"
      justifyContent="center"
      shouldFill={false}
    >
      <box
        width={66}
        borderStyle="rounded"
        border
        borderColor={theme.accent}
        backgroundColor={theme.panel}
        title=" Add worktree "
        titleAlignment="center"
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        {renderBody({
          phase,
          repo,
          repos,
          filtered: filteredRepos(),
          query,
          index,
          existing,
          prs: availablePrs,
          branch,
          errorMsg,
          loadingMore,
          onPick: (i: number) => {
            if (phase === "repoList") {
              const r = filteredRepos()[i];
              if (r) chooseRepo(r);
            } else if (phase === "actions") {
              if (i === 0) {
                setBranch("");
                setPhase("branchInput");
              } else if (i <= existing.length) {
                const wt = existing[i - 1];
                if (wt) void loadExisting(wt);
              } else {
                const pr = availablePrs[i - existing.length - 1];
                if (pr) createFromPr(pr);
              }
            }
          },
        })}
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------

interface BodyProps {
  phase: Phase;
  repo: RepoSummary | null;
  repos: RepoSummary[];
  filtered: RepoSummary[];
  query: string;
  index: number;
  existing: ExistingWorktree[];
  prs: OpenPr[];
  branch: string;
  errorMsg: string;
  loadingMore: boolean;
  /** Activate row `i` (click) — same as pressing Enter on it. */
  onPick?: (i: number) => void;
}

function renderBody(p: BodyProps) {
  switch (p.phase) {
    case "repoLoading":
      return <StatusLine text="Loading repositories…" />;
    case "repoError":
      return (
        <ErrorBlock
          message={p.errorMsg || "Could not list repositories."}
          hint="Is `gh` authenticated? Run `gh auth login`.  r retry · esc close"
        />
      );
    case "cloning":
      return (
        <StatusLine text={`Cloning ${p.repo?.nameWithOwner ?? ""}…`} />
      );
    case "cloneError":
      return (
        <ErrorBlock
          message={p.errorMsg || "Clone failed."}
          hint="r retry · esc back"
        />
      );
    case "creating":
      return <StatusLine text={`Creating worktree ${p.branch}…`} />;
    case "createError":
      return (
        <ErrorBlock
          message={p.errorMsg || "Could not create the worktree."}
          hint="r retry · esc back"
        />
      );
    case "repoList":
      return <RepoList {...p} />;
    case "actions":
      return <Actions {...p} />;
    case "branchInput":
      return <BranchInput {...p} />;
  }
}

function StatusLine({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <box paddingTop={1} paddingBottom={1}>
      <text fg={theme.fgMuted}>{text}</text>
    </box>
  );
}

function ErrorBlock({ message, hint }: { message: string; hint: string }) {
  const theme = useTheme();
  return (
    <box flexDirection="column">
      <text fg={theme.removed} wrapMode="word">
        {message}
      </text>
      <text fg={theme.fgFaint} attributes={TextAttributes.DIM} marginTop={1}>
        {hint}
      </text>
    </box>
  );
}

/** Windowed slice of a list keeping the selected index visible. */
function windowed<T>(items: T[], selected: number, max: number) {
  if (items.length <= max) return { start: 0, slice: items };
  let start = selected - Math.floor(max / 2);
  start = Math.max(0, Math.min(start, items.length - max));
  return { start, slice: items.slice(start, start + max) };
}

function RepoList(p: BodyProps) {
  const theme = useTheme();
  const { start, slice } = windowed(p.filtered, p.index, MAX_LIST_ROWS);
  return (
    <box flexDirection="column">
      <box flexDirection="row" marginBottom={1}>
        <text fg={theme.fgFaint}>{"filter "}</text>
        <text fg={theme.fg}>{p.query.length ? p.query : ""}</text>
        <text fg={theme.accent}>{"▏"}</text>
      </box>

      {slice.length === 0 && (
        <text fg={theme.fgMuted}>{"No matching repositories."}</text>
      )}

      {slice.map((r, i) => {
        const active = start + i === p.index;
        return (
          <box
            key={r.nameWithOwner}
            flexDirection="row"
            alignItems="center"
            onMouseDown={() => p.onPick?.(start + i)}
          >
            <text fg={active ? theme.accent : theme.panel} flexShrink={0}>
              {active ? "▶ " : "  "}
            </text>
            <text
              fg={active ? theme.fg : theme.fgMuted}
              attributes={active ? TextAttributes.BOLD : undefined}
              flexShrink={0}
            >
              {r.isPrivate ? "🔒 " : ""}
            </text>
            <text
              fg={active ? theme.fg : theme.fgMuted}
              attributes={active ? TextAttributes.BOLD : undefined}
              flexGrow={1}
              flexShrink={1}
              minWidth={0}
              wrapMode="none"
              truncate
            >
              {r.nameWithOwner}
            </text>
          </box>
        );
      })}

      <text fg={theme.fgFaint} attributes={TextAttributes.DIM} marginTop={1}>
        {`${p.filtered.length} repos${p.loadingMore ? " · loading more…" : ""} · ↑↓ move · ⏎ select · esc cancel`}
      </text>
    </box>
  );
}

function Actions(p: BodyProps) {
  const theme = useTheme();
  const rows = [
    { label: "＋ Create new worktree", hint: "" },
    ...p.existing.map((w) => ({
      label: (w.isMain ? "◆ " : "○ ") + w.name,
      hint: w.branch,
    })),
    ...p.prs.map((pr) => ({
      label: `⇄ #${pr.number} ${pr.title}`,
      hint: pr.headRefName,
    })),
  ];
  return (
    <box flexDirection="column">
      <text fg={theme.fgFaint} marginBottom={1} wrapMode="none" truncate>
        {p.repo?.nameWithOwner ?? ""}
      </text>
      {rows.map((row, i) => {
        const active = i === p.index;
        return (
          <box
            key={String(i)}
            flexDirection="row"
            alignItems="center"
            onMouseDown={() => p.onPick?.(i)}
          >
            <text fg={active ? theme.accent : theme.panel} flexShrink={0}>
              {active ? "▶ " : "  "}
            </text>
            <text
              fg={active ? theme.fg : theme.fgMuted}
              attributes={active ? TextAttributes.BOLD : undefined}
              flexShrink={0}
            >
              {row.label}
            </text>
            {row.hint ? (
              <text
                fg={theme.fgFaint}
                attributes={TextAttributes.DIM}
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                wrapMode="none"
                truncate
              >
                {"  " + row.hint}
              </text>
            ) : null}
          </box>
        );
      })}
      <text fg={theme.fgFaint} attributes={TextAttributes.DIM} marginTop={1}>
        {"↑↓ move · ⏎ select · esc back"}
      </text>
    </box>
  );
}

function BranchInput(p: BodyProps) {
  const theme = useTheme();
  return (
    <box flexDirection="column">
      <text fg={theme.fgMuted} marginBottom={1}>
        {"New branch name"}
      </text>
      <box flexDirection="row" alignItems="center">
        <text fg={theme.accent}>{"❯ "}</text>
        <text fg={theme.fg}>{p.branch.length ? p.branch : ""}</text>
        <text fg={theme.accent}>{"▏"}</text>
      </box>
      <text fg={theme.fgFaint} attributes={TextAttributes.DIM} marginTop={1}>
        {"⏎ create · esc back"}
      </text>
    </box>
  );
}

/** Score a repo against a lowercased query; higher is more relevant, 0 = no match. */
function relevance(q: string, r: RepoSummary): number {
  const name = r.name.toLowerCase();
  const full = r.nameWithOwner.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (full.includes(q)) return 40;
  return 0;
}

function isPrintable(name: string): boolean {
  return /^[A-Za-z0-9._/\-]$/.test(name);
}

function isBranchChar(name: string): boolean {
  return /^[A-Za-z0-9._/\-]$/.test(name);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
