import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ParsedKey } from "@opentui/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { openPrsQuery, reposQuery } from "../queries";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "../theme";
import { Dialog, rowLook } from "./Dialog";
import { Hints, hintsFrom } from "./Hints";
import type { OpenPr, Project, RepoSummary } from "../data/model";
import { branchLeaf, repoDir, sanitizeBranchForPath, worktreePath } from "../config";
import { clone } from "../services/gh";
import {
  addWorktree,
  canonicalPath,
  fetchPrBranch,
  ignoreWorktreesDir,
  listBranches,
  listWorktrees,
  localBranchExists,
  type Branches,
} from "../services/git";
import { addManagedWorktree, findRepo, reconcile, saveState, upsertRepo, type State } from "../store";
import { existsSync } from "node:fs";

type Phase =
  | "repoLoading"
  | "repoList"
  | "repoError"
  | "cloning"
  | "cloneError"
  | "actions"
  | "branchInput"
  | "baseList"
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
const NO_BRANCHES: Branches = { current: null, local: [], remote: [] };

/** A branch a new one can start from: `name` to show, `ref` in full for git, as a tag can share the name. */
interface BaseOption {
  name: string;
  ref: string;
}

export function AddWorktreeModal({ state, preselect, onClose, onApplied }: AddWorktreeModalProps) {
  const queryClient = useQueryClient();
  // Straight to the list when the repos are already cached (no loading flash).
  const [phase, setPhase] = useState<Phase>(() =>
    preselect ? "actions" : queryClient.getQueryData(reposQuery().queryKey) ? "repoList" : "repoLoading",
  );
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [root, setRoot] = useState<string>("");
  const [existing, setExisting] = useState<ExistingWorktree[]>([]);
  /** Whether `existing` has been read for the current repo yet. */
  const [existingLoaded, setExistingLoaded] = useState(false);

  const [pendingPr, setPendingPr] = useState<OpenPr | null>(null);
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<Branches>(NO_BRANCHES);
  /** The ref a new branch starts from; null = whatever the main copy has checked out. */
  const [base, setBase] = useState<BaseOption | null>(null);
  const [baseQuery, setBaseQuery] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  // Every repo `gh` can see: page 1 on screen as soon as it arrives, the rest
  // fetched in the background. Cached (src/queries.ts), so reopening the modal
  // is instant and a stale list refreshes behind the one on screen.
  const reposQ = useInfiniteQuery({ ...reposQuery(), enabled: !preselect });
  const repos = useMemo(() => reposQ.data?.pages.flatMap((p) => p.repos) ?? [], [reposQ.data]);
  useEffect(() => {
    if (reposQ.hasNextPage && !reposQ.isFetchingNextPage && !reposQ.isFetchNextPageError) {
      void reposQ.fetchNextPage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reposQ.hasNextPage, reposQ.isFetchingNextPage, reposQ.isFetchNextPageError]);
  const loadingMore = reposQ.isFetchingNextPage || (reposQ.hasNextPage && !reposQ.isFetchNextPageError);
  // Leave the loading screen once page 1 (or an error) is in.
  useEffect(() => {
    if (phase !== "repoLoading") return;
    if (reposQ.data) {
      setIndex(0);
      setQuery("");
      setPhase("repoList");
    } else if (reposQ.isError) {
      setErrorMsg(errText(reposQ.error));
      setPhase("repoError");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, reposQ.data, reposQ.isError]);

  // The chosen repo's open PRs — an extra option, so best-effort.
  const prsQ = useQuery({ ...openPrsQuery(repo?.nameWithOwner ?? ""), enabled: !!repo });
  const prs: OpenPr[] = prsQ.data ?? [];

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // PRs that don't already have a worktree for their branch. Until the repo's
  // worktrees are known, offer none — the (cached) PR list can arrive first,
  // and would briefly offer a PR whose worktree already exists.
  const availablePrs = existingLoaded ? prs.filter((pr) => !existing.some((w) => w.branch === pr.headRefName)) : [];

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
    branches,
    base,
    baseQuery,
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
    branches,
    base,
    baseQuery,
  };

  // A burst of keystrokes (fast typing, a paste, key repeat) is delivered in a
  // single tick, before React re-renders and refreshes the mirror above. These
  // update the mirror too, so each key in the burst sees the previous one.
  const applyQuery = (next: string) => {
    ref.current.query = next;
    setQuery(next);
  };
  const applyIndex = (next: number) => {
    ref.current.index = next;
    setIndex(next);
  };
  const applyBranch = (next: string) => {
    ref.current.branch = next;
    setBranch(next);
  };
  const applyBaseQuery = (next: string) => {
    ref.current.baseQuery = next;
    setBaseQuery(next);
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
      openActions(preselect.root);
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
      const isMain = canonicalPath(w.path) === canonicalPath(repoRoot);
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
      openActions(repoRoot);
    } else {
      setPhase("cloning");
      clone(r.nameWithOwner, repoRoot).then(
        () => {
          if (!mounted.current) return;
          openActions(repoRoot);
        },
        (err) => {
          if (!mounted.current) return;
          setErrorMsg(errText(err));
          setPhase("cloneError");
        },
      );
    }
  };

  const openActions = (repoRoot: string) => {
    ignoreWorktreesDir(repoRoot);
    setExistingLoaded(false);
    // Only the base picker needs these, so they load on the side and a failure leaves it empty.
    setBranches(NO_BRANCHES);
    listBranches(repoRoot).then(
      (br) => {
        if (mounted.current) setBranches(br);
      },
      () => {},
    );
    buildExisting(repoRoot).then(
      (list) => {
        if (!mounted.current) return;
        setExisting(list);
        setExistingLoaded(true);
        setIndex(0);
        setPhase("actions");
      },
      (err) => {
        if (!mounted.current) return;
        setErrorMsg(errText(err));
        setPhase("cloneError");
      },
    );
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

  const newBranchInput = () => {
    applyBranch("");
    setBase(null);
    setPhase("branchInput");
  };

  const openBaseList = () => {
    const s = ref.current;
    const want = s.base?.ref ?? (s.branches.current ? `refs/heads/${s.branches.current}` : "");
    const at = baseOptions(s.branches).findIndex((o) => o.ref === want);
    applyBaseQuery("");
    applyIndex(Math.max(at, 0));
    setPhase("baseList");
  };

  /** Back to the branch name, `chosen` as its base when given. Row 0 is where actions left off. */
  const closeBaseList = (chosen?: BaseOption) => {
    if (chosen) setBase(chosen);
    applyIndex(0);
    setPhase("branchInput");
  };

  /** `from` is the ref a new branch starts at, null for the main copy's HEAD. An existing branch ignores it. */
  const createWorktree = (branchName: string, from: string | null) => {
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
        const isMain = canonicalPath(same.path) === canonicalPath(root);
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
      await addWorktree(root, path, name, { newBranch: !exists, base: from ?? undefined });

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
        const isMain = canonicalPath(same.path) === canonicalPath(root);
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
    const typed = typedChar(key);

    // Escape is a universal back/cancel. With a preselected repo there's no
    // repo-picker to return to, so actions/cloneError close outright.
    if (name === "escape") {
      if (s.phase === "actions") return preselect ? onClose() : void setPhase("repoList");
      if (s.phase === "branchInput") return void setPhase("actions");
      if (s.phase === "baseList") return closeBaseList();
      if (s.phase === "cloneError") return preselect ? onClose() : void setPhase("repoList");
      if (s.phase === "createError") return void setPhase(s.pendingPr ? "actions" : "branchInput");
      return onClose();
    }

    switch (s.phase) {
      case "repoError": {
        if (name === "r") {
          setPhase("repoLoading");
          void reposQ.refetch();
        }
        return;
      }
      case "repoList": {
        const list = filteredRepos();
        if (name === "down" || name === "j") {
          applyIndex(Math.min(s.index + 1, Math.max(list.length - 1, 0)));
        } else if (name === "up" || name === "k") {
          applyIndex(Math.max(s.index - 1, 0));
        } else if (name === "return") {
          const chosen = list[s.index];
          if (chosen) chooseRepo(chosen);
        } else if (name === "backspace") {
          applyQuery(s.query.slice(0, -1));
          applyIndex(0);
        } else if (typed && isPrintable(typed)) {
          applyQuery(s.query + typed);
          applyIndex(0);
        }
        return;
      }
      case "actions": {
        const total = s.existing.length + s.prs.length + 1; // +1 for "create new"
        if (name === "down" || name === "j") {
          applyIndex(Math.min(s.index + 1, total - 1));
        } else if (name === "up" || name === "k") {
          applyIndex(Math.max(s.index - 1, 0));
        } else if (name === "return") {
          if (s.index === 0) {
            newBranchInput();
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
          createWorktree(s.branch, s.base?.ref ?? null);
        } else if (name === "tab") {
          openBaseList();
        } else if (name === "backspace") {
          applyBranch(s.branch.slice(0, -1));
        } else if (typed && isBranchChar(typed)) {
          applyBranch(s.branch + typed);
        }
        return;
      }
      case "baseList": {
        // Arrows only: j/k are letters a branch filter needs.
        const list = filterBases(baseOptions(s.branches), s.baseQuery);
        if (name === "down") {
          applyIndex(Math.min(s.index + 1, Math.max(list.length - 1, 0)));
        } else if (name === "up") {
          applyIndex(Math.max(s.index - 1, 0));
        } else if (name === "return") {
          const chosen = list[s.index];
          if (chosen) closeBaseList(chosen);
        } else if (name === "backspace") {
          applyBaseQuery(s.baseQuery.slice(0, -1));
          applyIndex(0);
        } else if (typed && isBranchChar(typed)) {
          applyBaseQuery(s.baseQuery + typed);
          applyIndex(0);
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
          else createWorktree(s.branch, s.base?.ref ?? null);
        }
        return;
      }
    }
  });

  // Busy (loading, cloning, creating): it can't be closed until that's done.
  const busy = phase === "repoLoading" || phase === "cloning" || phase === "creating";
  const filteredBases = filterBases(baseOptions(branches), baseQuery);
  return (
    <Dialog title="Add worktree" width={70} onClose={busy ? undefined : onClose}>
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
        branches,
        base,
        baseQuery,
        bases: filteredBases,
        errorMsg,
        loadingMore,
        onPick: (i: number) => {
          if (phase === "repoList") {
            const r = filteredRepos()[i];
            if (r) chooseRepo(r);
          } else if (phase === "actions") {
            if (i === 0) {
              newBranchInput();
            } else if (i <= existing.length) {
              const wt = existing[i - 1];
              if (wt) void loadExisting(wt);
            } else {
              const pr = availablePrs[i - existing.length - 1];
              if (pr) createFromPr(pr);
            }
          } else if (phase === "baseList") {
            const chosen = filteredBases[i];
            if (chosen) closeBaseList(chosen);
          }
        },
      })}
    </Dialog>
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
  branches: Branches;
  base: BaseOption | null;
  baseQuery: string;
  /** Base candidates matching `baseQuery`. */
  bases: BaseOption[];
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
          note="Is `gh` authenticated? Run `gh auth login`."
          hint="r retry · esc close"
        />
      );
    case "cloning":
      return <StatusLine text={`Cloning ${p.repo?.nameWithOwner ?? ""}…`} />;
    case "cloneError":
      return <ErrorBlock message={p.errorMsg || "Clone failed."} hint="r retry · esc back" />;
    case "creating":
      return <StatusLine text={`Creating worktree ${p.branch}…`} />;
    case "createError":
      return <ErrorBlock message={p.errorMsg || "Could not create the worktree."} hint="r retry · esc back" />;
    case "repoList":
      return <RepoList {...p} />;
    case "actions":
      return <Actions {...p} />;
    case "branchInput":
      return <BranchInput {...p} />;
    case "baseList":
      return <BaseList {...p} />;
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

function ErrorBlock({ message, note, hint }: { message: string; note?: string; hint: string }) {
  const theme = useTheme();
  return (
    <box flexDirection="column">
      <text fg={theme.removed} wrapMode="word">
        {message}
      </text>
      {note && (
        <text fg={theme.fgMuted} marginTop={1} wrapMode="word">
          {note}
        </text>
      )}
      <Hints marginTop={1} hints={hintsFrom(hint)} />
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

      {slice.length === 0 && <text fg={theme.fgMuted}>{"No matching repositories."}</text>}

      {slice.map((r, i) => {
        const active = start + i === p.index;
        const look = rowLook(theme, active);
        return (
          <box
            key={r.nameWithOwner}
            flexDirection="row"
            alignItems="center"
            backgroundColor={look.bg}
            onMouseDown={() => p.onPick?.(start + i)}
          >
            <text fg={look.marker} flexShrink={0}>
              {active ? " ▶ " : "   "}
            </text>
            <text fg={look.fg} attributes={look.bold} flexShrink={0}>
              {r.isPrivate ? "🔒 " : ""}
            </text>
            <text fg={look.fg} attributes={look.bold} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
              {r.nameWithOwner}
            </text>
          </box>
        );
      })}

      <box flexDirection="row" marginTop={1}>
        <text fg={theme.fgMuted} flexShrink={0}>
          {`${p.filtered.length} repos${p.loadingMore ? " · loading more…" : ""} · `}
        </text>
        <Hints hints={hintsFrom("↑↓ move · ⏎ select · esc cancel")} />
      </box>
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
        const look = rowLook(theme, active);
        return (
          <box
            key={String(i)}
            flexDirection="row"
            alignItems="center"
            backgroundColor={look.bg}
            onMouseDown={() => p.onPick?.(i)}
          >
            <text fg={look.marker} flexShrink={0}>
              {active ? " ▶ " : "   "}
            </text>
            <text fg={look.fg} attributes={look.bold} flexShrink={0}>
              {row.label}
            </text>
            {row.hint ? (
              <text fg={look.muted} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
                {"  " + row.hint}
              </text>
            ) : null}
          </box>
        );
      })}
      <Hints marginTop={1} hints={hintsFrom("↑↓ move · ⏎ select · esc back")} />
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
      <text fg={theme.fgFaint} wrapMode="none" truncate>
        {p.branches.local.includes(p.branch.trim())
          ? "existing branch"
          : `from ${p.base?.name ?? p.branches.current ?? "HEAD"}`}
      </text>
      <Hints marginTop={1} hints={hintsFrom("⏎ create · tab base · esc back")} />
    </box>
  );
}

function BaseList(p: BodyProps) {
  const theme = useTheme();
  const { start, slice } = windowed(p.bases, p.index, MAX_LIST_ROWS);
  return (
    <box flexDirection="column">
      <text fg={theme.fgMuted} marginBottom={1} wrapMode="none" truncate>
        {`Base for ${p.branch.trim() || "the new branch"}`}
      </text>
      <box flexDirection="row" marginBottom={1}>
        <text fg={theme.fgFaint}>{"filter "}</text>
        <text fg={theme.fg}>{p.baseQuery}</text>
        <text fg={theme.accent}>{"▏"}</text>
      </box>

      {slice.length === 0 && <text fg={theme.fgMuted}>{"No matching branches."}</text>}

      {slice.map((b, i) => {
        const active = start + i === p.index;
        const look = rowLook(theme, active);
        return (
          <box
            key={b.ref}
            flexDirection="row"
            alignItems="center"
            backgroundColor={look.bg}
            onMouseDown={() => p.onPick?.(start + i)}
          >
            <text fg={look.marker} flexShrink={0}>
              {active ? " ▶ " : "   "}
            </text>
            <text fg={look.fg} attributes={look.bold} flexShrink={1} minWidth={0} wrapMode="none" truncate>
              {b.name}
            </text>
            {b.ref === `refs/heads/${p.branches.current}` ? (
              <text fg={look.muted} flexShrink={0}>
                {"  current"}
              </text>
            ) : null}
          </box>
        );
      })}

      <Hints marginTop={1} hints={hintsFrom("↑↓ move · ⏎ select · esc back")} />
    </box>
  );
}

/** Where a new branch can start: the checked-out branch first, then other local ones, then remote ones. */
function baseOptions(b: Branches): BaseOption[] {
  const local = b.current ? [b.current, ...b.local.filter((x) => x !== b.current)] : b.local;
  return [
    ...local.map((name) => ({ name, ref: `refs/heads/${name}` })),
    ...b.remote.map((name) => ({ name, ref: `refs/remotes/${name}` })),
  ];
}

function filterBases(options: BaseOption[], q: string): BaseOption[] {
  const needle = q.trim().toLowerCase();
  return needle ? options.filter((o) => o.name.toLowerCase().includes(needle)) : options;
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

/**
 * The character a key event typed, or null for keys that type nothing.
 * `key.name` is lowercased with a separate shift flag, so an uppercase letter
 * has to come from the sequence — otherwise `JIRA-12` types as `jira-12`.
 */
function typedChar(key: ParsedKey): string | null {
  if (key.ctrl || key.meta || key.option) return null;
  const seq = key.sequence ?? "";
  return seq.length === 1 ? seq : null;
}

function isPrintable(ch: string): boolean {
  return /^[A-Za-z0-9._/-]$/.test(ch);
}

function isBranchChar(ch: string): boolean {
  return /^[A-Za-z0-9._/-]$/.test(ch);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
