import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { existsSync } from "node:fs";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  QueryClientProvider,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { bindTerminalFocus, createQueryClient } from "./queryClient";
import {
  agentStatusQuery,
  gitStatusQuery,
  prForBranchQuery,
  queryKeys,
} from "./queries";
import { useTheme, cycleTheme } from "./theme";
import { displayName, type AgentStatus, type Project, type Worktree } from "./data/model";
import { removeWorktree } from "./services/git";
import { killSession, sessionName as tmuxSessionName, tmuxOn } from "./services/tmux";
import { Sidebar, projectKey, worktreeKey } from "./components/Sidebar";
import {
  AddWorktreeModal,
  type PreselectRepo,
  type Selection,
} from "./components/AddWorktreeModal";
import {
  reconcile,
  removeManagedWorktree,
  MAX_LABEL_LENGTH,
  removeHost,
  removeRemoteDir,
  sshProjectId,
  saveState,
  setWorktreeLabel,
  type State,
  type UiState,
} from "./store";
import {
  DEFAULT_PR_PANEL_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MIN_CONTENT_WIDTH,
  MIN_PR_PANEL_WIDTH,
  SIDEBAR_WIDTH_STEP,
  clampSidebarWidth,
  fitPanels,
} from "./layout";
import { TerminalPane } from "./components/TerminalPane";
import { HelpOverlay } from "./components/HelpOverlay";
import { PrPanel, type PrPanelHandle, type PrSection } from "./components/PrPanel";
import { openExternal } from "./services/open";
import type { PrInfo } from "./data/model";
import { ConfirmModal } from "./components/ConfirmModal";
import { RenameModal } from "./components/RenameModal";
import { MergeModal } from "./components/MergeModal";
import { SshModal } from "./components/SshModal";
import type { DiffViewerId } from "./services/diff";

function MainPane({ row, sidebarHidden }: { row: Row | undefined; sidebarHidden?: boolean }) {
  const theme = useTheme();
  const label = !row
    ? "agentree"
    : row.kind === "worktree"
      ? displayName(row.worktree)
      : row.project.name;
  const subtitle =
    row?.kind === "worktree"
      ? row.worktree.host
        ? `${row.worktree.host}:${row.worktree.subtitle ?? row.worktree.path}`
        : row.worktree.path
      : row?.kind === "project"
        ? row.project.root
        : "Press n to add a project";

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      backgroundColor={theme.bg}
      alignItems="center"
      justifyContent="center"
    >
      <ascii-font font="tiny" text={label} />
      <text fg={theme.fgMuted}>{subtitle}</text>
      <text fg={theme.fgFaint} attributes={TextAttributes.DIM}>
        {sidebarHidden ? "The sidebar is hidden — b shows it" : "tmux session would render here"}
      </text>
    </box>
  );
}

export type Row =
  | { kind: "project"; project: Project }
  | { kind: "worktree"; project: Project; worktree: Worktree };

/** The visible, navigable rows: every project header, plus the worktrees of expanded projects. */
export function buildRows(projects: Project[], collapsed: Set<string>): Row[] {
  const rows: Row[] = [];
  for (const project of projects) {
    rows.push({ kind: "project", project });
    if (!collapsed.has(project.id)) {
      for (const worktree of project.worktrees) {
        rows.push({ kind: "worktree", project, worktree });
      }
    }
  }
  return rows;
}

export function rowKey(row: Row): string {
  return row.kind === "project"
    ? projectKey(row.project.id)
    : worktreeKey(row.project.id, row.worktree.id);
}

/** Two clicks on the same worktree row within this count as a double-click. */
const DOUBLE_CLICK_MS = 400;
/** At most one extra PR lookup this often (agent state changes come in bursts). */
const PR_LOOKUP_THROTTLE_MS = 15_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function samePr(a: PrInfo | undefined, b: PrInfo | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.number === b.number &&
    a.title === b.title &&
    a.url === b.url &&
    a.draft === b.draft &&
    a.checks === b.checks
  );
}

export interface AppProps {
  initialProjects: Project[];
  state: State;
  /** Leave the app. Injected so tests can assert a quit without exiting the runner. */
  onQuit?: () => void;
  /** The cache for GitHub data; tests pass one with their own timings. Default: a fresh one. */
  queryClient?: QueryClient;
}

export function App(props: AppProps) {
  // One query cache per app — tests render many apps, which mustn't share data.
  const [client] = useState(() => props.queryClient ?? createQueryClient());
  // The terminal window's focus is the query cache's "window focus".
  const renderer = useRenderer();
  useEffect(() => bindTerminalFocus(renderer), [renderer]);
  useEffect(
    () => () => {
      if (!props.queryClient) client.clear(); // drop cached data and its timers
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  );
  return (
    <QueryClientProvider client={client}>
      <AppShell {...props} />
    </QueryClientProvider>
  );
}

function AppShell({ initialProjects, state, onQuit }: AppProps) {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeIndex, setActiveIndex] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [preselect, setPreselect] = useState<PreselectRepo | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // The worktree whose terminal is visible in the content pane, and where keys go.
  const [open, setOpen] = useState<{ repoId: string; worktreeId: string } | null>(
    null,
  );
  // Every worktree opened at least once. Their terminals stay mounted (hidden)
  // so switching back is instant: re-attaching tmux would clear+redraw the
  // emulator, which reads as a flash. Only the `open` one is visible.
  const [opened, setOpened] = useState<
    { repoId: string; worktreeId: string }[]
  >([]);
  const [focusMode, setFocusMode] = useState<"sidebar" | "terminal">("sidebar");
  // Pending "close worktree" confirmation (d key).
  const [confirmClose, setConfirmClose] = useState<{
    repoId: string;
    worktreeId: string;
    /** How the prompt names it: `"label" (branch)` when it has a label, else `"name"`. */
    what: string;
    dirty: boolean;
    missing: boolean;
  } | null>(null);
  // An error to show (closing a worktree failed, say) until dismissed.
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  // The worktree being renamed (R / right-click): a label for the sidebar only.
  const [renaming, setRenaming] = useState<{
    repoId: string;
    worktreeId: string;
    label: string;
    name: string;
    branch: string;
  } | null>(null);
  // Sidebar width the user chose (drag / [ ] keys), remembered in state.json.
  // What's rendered is this clamped to the current screen, so shrinking the
  // window doesn't lose the preference.
  const [sidebarWidth, setSidebarWidth] = useState(
    () => state.ui?.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH,
  );
  const { width: screenWidth } = useTerminalDimensions();
  // The PR panel on the right, for the worktree on screen when it has a PR:
  // shown unless switched off with `p`. Both that and its width are remembered.
  const [prPanelHidden, setPrPanelHidden] = useState(() => state.ui?.prPanelHidden ?? false);
  // The diff viewer picked in the diff picker (v); remembered. Unset = auto.
  const [diffViewer, setDiffViewer] = useState(() => state.ui?.diffViewer);
  const chooseDiffViewer = (id: DiffViewerId) => {
    setDiffViewer(id);
    saveUi({ diffViewer: id });
  };
  // The sidebar can be hidden (b) to give the terminal the whole width; remembered.
  const [sidebarHidden, setSidebarHidden] = useState(() => state.ui?.sidebarHidden ?? false);
  const [prPanelWidth, setPrPanelWidth] = useState(
    () => state.ui?.prPanelWidth ?? DEFAULT_PR_PANEL_WIDTH,
  );
  // PR panel sections folded away (click a section's header), remembered.
  const [prCollapsed, setPrCollapsed] = useState<PrSection[]>(
    () => (state.ui?.prPanelCollapsed ?? []) as PrSection[],
  );
  const prPanelRef = useRef<PrPanelHandle | null>(null);
  /** The PR on screen (set while rendering), for the key handler. */
  const currentPrRef = useRef<{ repo: string; pr: PrInfo } | null>(null);
  /** The rendered side-panel widths (set while rendering). */
  const layoutRef = useRef({ sidebar: 0, panel: 0 });

  // Refs mirror state so the keyboard handler always reads current values.
  const projectsRef = useRef(projects); // set to the live view further down
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  const modalOpenRef = useRef(modalOpen);
  modalOpenRef.current = modalOpen;
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;
  const openRef = useRef(open);
  openRef.current = open;
  const confirmCloseRef = useRef(confirmClose);
  confirmCloseRef.current = confirmClose;
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  // Adding an SSH host (s), or a directory to one (its ＋ / a).
  const [sshModal, setSshModal] = useState<{ host?: string } | null>(null);
  const sshModalRef = useRef(sshModal);
  sshModalRef.current = sshModal;
  // Pending "forget" of an SSH directory, or a whole host (d): nothing on the
  // host is deleted, only its tmux sessions end.
  const [confirmForget, setConfirmForget] = useState<{
    host: string;
    dirId?: string;
    what: string;
    needsPassword?: boolean;
  } | null>(null);
  const confirmForgetRef = useRef(confirmForget);
  confirmForgetRef.current = confirmForget;
  // The PR being merged (m / the PR panel's Merge button).
  const [merging, setMerging] = useState<{ repo: string; pr: PrInfo } | null>(null);
  const mergingRef = useRef(merging);
  mergingRef.current = merging;
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const screenWidthRef = useRef(screenWidth);
  screenWidthRef.current = screenWidth;
  const prPanelHiddenRef = useRef(prPanelHidden);
  prPanelHiddenRef.current = prPanelHidden;
  const sidebarHiddenRef = useRef(sidebarHidden);
  sidebarHiddenRef.current = sidebarHidden;
  const prPanelWidthRef = useRef(prPanelWidth);
  prPanelWidthRef.current = prPanelWidth;
  const prCollapsedRef = useRef(prCollapsed);
  prCollapsedRef.current = prCollapsed;

  // ── What the sidebar shows beyond state.json, through the query cache ──
  // (src/queries.ts: keys, fetchers, poll intervals). Merged into `viewProjects`
  // below rather than written into `projects`.
  // (Local git only: an SSH project's directories have no git status or PRs.)
  const liveWorktrees = projects
    .filter((p) => !p.ssh)
    .flatMap((p) => p.worktrees.filter((w) => !w.missing).map((w) => ({ repoId: p.id, worktree: w })));

  // Git status (dirty, changed files, +/−, ahead/behind) — polled per worktree,
  // invalidated when an agent changes state (it has probably touched files).
  const gitStatuses = useQueries({
    queries: liveWorktrees.map(({ worktree }) => gitStatusQuery(worktree.path)),
  });

  // Each branch's open PR (the ⇡#N badge) — polled every minute, invalidated
  // when an agent changes state and on `r`. A failed lookup keeps the last
  // answer rather than dropping the badge.
  const prTargets = liveWorktrees.filter(
    ({ worktree: w }) => w.branch && w.branch !== "(detached)",
  );
  const branchPrs = useQueries({
    queries: prTargets.map(({ repoId, worktree }) => prForBranchQuery(repoId, worktree.branch)),
  });
  // A PR whose checks or title moved has newer details too: mark its cached
  // details stale, so the panel refetches them when it next shows that PR.
  const knownPrs = useRef(new Map<string, PrInfo>());
  const branchPrSig = branchPrs.map((q) => JSON.stringify(q.data ?? null)).join("|");
  useEffect(() => {
    const next = new Map<string, PrInfo>();
    prTargets.forEach(({ repoId }, i) => {
      const pr = branchPrs[i]?.data;
      if (!pr) return;
      const key = `${repoId}#${pr.number}`;
      const before = knownPrs.current.get(key);
      if (before && !samePr(before, pr)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.prDetails(repoId, pr.number) });
      }
      next.set(key, pr);
    });
    knownPrs.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchPrSig]);

  /** Re-ask GitHub for every branch's PR, at most once per PR_LOOKUP_THROTTLE_MS. */
  const lastPrInvalidation = useRef(0);
  const invalidatePrLookupsSoon = () => {
    const now = Date.now();
    if (now - lastPrInvalidation.current < PR_LOOKUP_THROTTLE_MS) return;
    lastPrInvalidation.current = now;
    void queryClient.invalidateQueries({ queryKey: queryKeys.allPrForBranch });
  };

  // Live agent status per tmux session (services/agents), shown with "done"
  // turned into "idle" once that worktree's terminal has been on screen.
  const agentReports = useQuery(agentStatusQuery()).data;
  const openSession = open ? tmuxSessionName(open.repoId, open.worktreeId) : null;
  /** When each session's terminal was last on screen (epoch seconds). */
  const [seenAt, setSeenAt] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!openSession) return;
    const now = Math.floor(Date.now() / 1000);
    setSeenAt((prev) => (prev[openSession] === now ? prev : { ...prev, [openSession]: now }));
  }, [openSession, agentReports]);
  const agentStatus: Record<string, AgentStatus> = {};
  for (const [session, r] of Object.entries(agentReports ?? {})) {
    const seen = session === openSession || (seenAt[session] ?? 0) >= r.since;
    agentStatus[session] = r.state === "done" && seen ? "idle" : r.state;
  }
  // An agent changing state has probably touched files, and may have opened
  // or pushed to a PR.
  const reportsSig = JSON.stringify(agentReports ?? null);
  const lastReportsSig = useRef<string | null>(null);
  useEffect(() => {
    if (lastReportsSig.current !== null && lastReportsSig.current !== reportsSig) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.allGitStatus });
      invalidatePrLookupsSoon();
    }
    lastReportsSig.current = reportsSig;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportsSig]);

  // Projects as the sidebar shows them: state.json's worktrees plus live git
  // status, PR and agent status.
  const statusByPath = new Map(liveWorktrees.map(({ worktree }, i) => [worktree.path, gitStatuses[i]?.data]));
  const prByWorktree = new Map(
    prTargets.map(({ repoId, worktree }, i) => [`${repoId}:${worktree.id}`, branchPrs[i]?.data]),
  );
  const viewProjects: Project[] = projects.map((p) => ({
    ...p,
    worktrees: p.worktrees.map((w) => {
      const st = w.missing ? undefined : statusByPath.get(w.path);
      const pr = prByWorktree.get(`${p.id}:${w.id}`) ?? undefined;
      return { ...w, ...st, pr, agent: agentStatus[tmuxSessionName(p.id, w.id)] ?? "none" };
    }),
  }));
  // Handlers read the live view (a worktree's dirty flag, say), not just state.json.
  projectsRef.current = viewProjects;

  // A burst of keystrokes (key repeat, a paste) arrives in one tick, before
  // React re-renders and refreshes the mirrors above, so every write also
  // updates the mirror — otherwise holding `j` advances a single row.
  const applyActiveIndex = (idx: number) => {
    activeIndexRef.current = idx;
    setActiveIndex(idx);
  };
  /** Set the sidebar width (clamped to the screen), updating the mirror too. */
  const applySidebarWidth = (width: number) => {
    const next = clampSidebarWidth(width, screenWidthRef.current);
    sidebarWidthRef.current = next;
    setSidebarWidth(next);
    return next;
  };

  /**
   * Remember the sidebar width in state.json: once when a drag is released, and
   * on each `[` / `]` / `=` that changes it. Written straight away rather than
   * debounced, so quitting right after a resize can't drop it. The default width
   * isn't stored, so a future change to the default still applies.
   */
  const persistSidebarWidth = () => {
    const width = sidebarWidthRef.current;
    saveUi({ sidebarWidth: width === DEFAULT_SIDEBAR_WIDTH ? undefined : width });
  };

  /** Merge UI preferences into state.json; `undefined` drops a field. No-op if nothing changed. */
  const saveUi = (patch: Partial<UiState>) => {
    const ui: Record<string, unknown> = { ...state.ui };
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (ui[key] === value) continue;
      changed = true;
      if (value === undefined) delete ui[key];
      else ui[key] = value;
    }
    if (!changed) return;
    if (Object.keys(ui).length > 0) state.ui = ui as UiState;
    else delete state.ui;
    void saveState(state).catch(() => {});
  };

  /** Show / hide the sidebar, and remember it. */
  const applySidebarHidden = (hidden: boolean) => {
    sidebarHiddenRef.current = hidden;
    setSidebarHidden(hidden);
    saveUi({ sidebarHidden: hidden || undefined });
  };

  /**
   * Hide the sidebar (`b`, its ⇤): the keys go to the terminal on screen, if
   * there is one. Shown again by `b`, or by going back to it (Ctrl+g, ‹).
   */
  const hideSidebar = () => {
    applySidebarHidden(true);
    if (openRef.current) setFocusMode("terminal");
  };

  /** Back to the sidebar (Ctrl+g, the tab bar's ‹) — showing it if it was hidden. */
  const exitToSidebar = () => {
    if (sidebarHiddenRef.current) applySidebarHidden(false);
    setFocusMode("sidebar");
  };

  /** Show / hide the PR panel (`p`, ⌥p, its ✕, or the tab bar's PR button). */
  const togglePrPanel = () => {
    const hidden = !prPanelHiddenRef.current;
    prPanelHiddenRef.current = hidden;
    setPrPanelHidden(hidden);
    saveUi({ prPanelHidden: hidden || undefined });
  };

  /** Fold / unfold a PR panel section, and remember it. */
  const togglePrSection = (section: PrSection) => {
    const prev = prCollapsedRef.current;
    const next = prev.includes(section) ? prev.filter((s) => s !== section) : [...prev, section];
    prCollapsedRef.current = next;
    setPrCollapsed(next);
    saveUi({ prPanelCollapsed: next.length > 0 ? next : undefined });
  };

  /** Resize the PR panel, within what's left beside the sidebar and content. */
  const applyPrPanelWidth = (width: number) => {
    const room = screenWidthRef.current - layoutRef.current.sidebar - MIN_CONTENT_WIDTH;
    const next = Math.round(Math.min(Math.max(width, MIN_PR_PANEL_WIDTH), Math.max(room, MIN_PR_PANEL_WIDTH)));
    prPanelWidthRef.current = next;
    setPrPanelWidth(next);
  };
  const persistPrPanelWidth = () => {
    const width = prPanelWidthRef.current;
    saveUi({ prPanelWidth: width === DEFAULT_PR_PANEL_WIDTH ? undefined : width });
  };
  const resetPrPanelWidth = () => {
    applyPrPanelWidth(DEFAULT_PR_PANEL_WIDTH);
    persistPrPanelWidth();
  };

  const resetSidebarWidth = () => {
    applySidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    persistSidebarWidth();
  };

  const applyCollapsed = (next: Set<string>) => {
    collapsedRef.current = next;
    setCollapsed(next);
  };

  const setCollapsedFor = (projectId: string, wantCollapsed: boolean) => {
    const next = new Set(collapsedRef.current);
    if (wantCollapsed) next.add(projectId);
    else next.delete(projectId);
    applyCollapsed(next);
    // Keep the selection valid: snap to the project header in the new layout.
    const rows = buildRows(projectsRef.current, next);
    const idx = rows.findIndex(
      (r) => r.kind === "project" && r.project.id === projectId,
    );
    if (idx >= 0) applyActiveIndex(idx);
  };

  const handleApplied = (newProjects: Project[], sel: Selection) => {
    setSshModal(null);
    setProjects(newProjects);
    const nextCollapsed = new Set(collapsedRef.current);
    nextCollapsed.delete(sel.repoId);
    applyCollapsed(nextCollapsed);
    const rows = buildRows(newProjects, nextCollapsed);
    const idx = rows.findIndex(
      (r) =>
        r.kind === "worktree" &&
        r.project.id === sel.repoId &&
        r.worktree.id === sel.worktreeId,
    );
    if (idx >= 0) applyActiveIndex(idx);
    // Mount the new worktree's terminal so the content pane matches the
    // sidebar selection, instead of leaving the previously open one behind.
    // Focus stays on the sidebar (unlike Enter/click), so keyboard shortcuts
    // keep working right after the modal closes.
    markOpened(sel.repoId, sel.worktreeId);
    setOpen({ repoId: sel.repoId, worktreeId: sel.worktreeId });
    setModalOpen(false);
    setPreselect(null);
  };

  const openAdd = (pre: PreselectRepo | null) => {
    setPreselect(pre);
    setModalOpen(true);
  };

  /** Record a worktree as opened so its terminal stays mounted across switches. */
  const markOpened = (repoId: string, worktreeId: string) => {
    setOpened((prev) =>
      prev.some((o) => o.repoId === repoId && o.worktreeId === worktreeId)
        ? prev
        : [...prev, { repoId, worktreeId }],
    );
  };

  const renderer = useRenderer();
  const quit = () => {
    try {
      renderer.destroy();
    } catch {
      // fall through to hard exit
    }
    if (onQuit) onQuit();
    else process.exit(0);
  };

  /** Open the add-worktree modal with the given project's repo preselected. */
  const openAddForProject = (projectId: string) => {
    const proj = projectsRef.current.find((p) => p.id === projectId);
    if (!proj) return;
    if (proj.ssh) {
      setFocusMode("sidebar");
      setSshModal({ host: proj.ssh.host });
      return;
    }
    openAdd({ nameWithOwner: proj.id, name: proj.name, root: proj.root });
  };

  /** Open (mount + focus) a worktree's terminal — used by click and Enter. */
  const openWorktreeTerminal = (repoId: string, worktreeId: string) => {
    markOpened(repoId, worktreeId);
    setOpen({ repoId, worktreeId });
    setFocusMode("terminal");
    const rows = buildRows(projectsRef.current, collapsedRef.current);
    const idx = rows.findIndex(
      (r) =>
        r.kind === "worktree" &&
        r.project.id === repoId &&
        r.worktree.id === worktreeId,
    );
    if (idx >= 0) applyActiveIndex(idx);
  };

  /**
   * Select a worktree and show its terminal, keeping the keyboard in the
   * sidebar (a click on its row). A worktree that's gone on disk is only selected.
   */
  const showWorktree = (repoId: string, worktreeId: string) => {
    const worktree = projectsRef.current
      .find((p) => p.id === repoId)
      ?.worktrees.find((w) => w.id === worktreeId);
    if (worktree && !worktree.missing) {
      markOpened(repoId, worktreeId);
      setOpen({ repoId, worktreeId });
    }
    setFocusMode("sidebar");
    const rows = buildRows(projectsRef.current, collapsedRef.current);
    const idx = rows.findIndex(
      (r) => r.kind === "worktree" && r.project.id === repoId && r.worktree.id === worktreeId,
    );
    if (idx >= 0) applyActiveIndex(idx);
  };

  /** A worktree row was clicked: select + show it; a second click on it soon after types in it. */
  const lastRowClick = useRef({ key: "", at: 0 });
  const clickWorktree = (repoId: string, worktreeId: string) => {
    const key = `${repoId}:${worktreeId}`;
    const now = Date.now();
    const double = lastRowClick.current.key === key && now - lastRowClick.current.at < DOUBLE_CLICK_MS;
    lastRowClick.current = double ? { key: "", at: 0 } : { key, at: now };
    const missing = projectsRef.current
      .find((p) => p.id === repoId)
      ?.worktrees.find((w) => w.id === worktreeId)?.missing;
    if (double && !missing) openWorktreeTerminal(repoId, worktreeId);
    else showWorktree(repoId, worktreeId);
  };

  /** Click a project header: return focus to the sidebar and toggle its fold. */
  const selectProject = (projectId: string) => {
    setFocusMode("sidebar");
    setCollapsedFor(projectId, !collapsedRef.current.has(projectId));
  };

  /** Ask to close (delete from disk) the worktree under the cursor. */
  const requestCloseWorktree = (row: Row | undefined) => {
    // An SSH project: forget a directory, or (on its header) the whole host.
    if (row?.project.ssh) {
      const { host, needsPassword } = row.project.ssh;
      setConfirmForget(
        row.kind === "worktree"
          ? { host, dirId: row.worktree.id, what: row.worktree.subtitle ?? row.worktree.path, needsPassword }
          : { host, what: host, needsPassword },
      );
      return;
    }
    if (!row || row.kind !== "worktree") return;
    if (row.worktree.id === "main") {
      setNotice({
        title: "Could not close worktree",
        message: "The main working copy can't be closed this way — remove the project instead.",
      });
      return;
    }
    setConfirmClose({
      repoId: row.project.id,
      worktreeId: row.worktree.id,
      what: row.worktree.label
        ? `"${row.worktree.label}" (${row.worktree.branch})`
        : `"${row.worktree.name}"`,
      dirty: row.worktree.dirty,
      missing: !!row.worktree.missing,
    });
  };

  /** Kill its tmux session, delete it on disk (unless already missing), and drop it from state. */
  const performCloseWorktree = async () => {
    const target = confirmCloseRef.current;
    if (!target) return;
    setConfirmClose(null);
    try {
      const project = projectsRef.current.find((p) => p.id === target.repoId);
      const wt = project?.worktrees.find((w) => w.id === target.worktreeId);
      // `--force` also cleans up a worktree whose directory is already gone —
      // git still tracks it as "prunable" until told to remove it, and
      // leaving that behind would make reconcile() re-adopt it right back.
      if (project && wt && existsSync(project.root)) {
        await killSession(tmuxSessionName(target.repoId, target.worktreeId)).catch(
          () => {},
        );
        await removeWorktree(project.root, wt.path, { force: true });
      }
      await removeManagedWorktree(state, target.repoId, target.worktreeId);
      const newProjects = await reconcile(state);
      setProjects(newProjects);

      // The closed worktree's terminal is no longer valid: drop it from the
      // mounted set (unmounts it, tearing down its PTY).
      const isClosed = (o: { repoId: string; worktreeId: string }) =>
        o.repoId === target.repoId && o.worktreeId === target.worktreeId;
      const remaining = opened.filter((o) => !isClosed(o));
      setOpened(remaining);

      // If it was the visible one, fall back to another mounted terminal (or
      // the placeholder pane) and return focus to the sidebar.
      const wasOpen = openRef.current;
      if (wasOpen && isClosed(wasOpen)) {
        setOpen(remaining[remaining.length - 1] ?? null);
        setFocusMode("sidebar");
      }

      // Keep the selection in bounds in the new (shorter) row list.
      const rows = buildRows(newProjects, collapsedRef.current);
      applyActiveIndex(Math.min(activeIndexRef.current, Math.max(rows.length - 1, 0)));
    } catch (err) {
      setNotice({ title: "Could not close worktree", message: errText(err) });
    }
  };

  /**
   * Forget an SSH directory (or a whole host): end its tmux session(s) on the
   * host and drop it from state. Nothing on the host is deleted.
   */
  const performForget = async () => {
    const target = confirmForgetRef.current;
    if (!target) return;
    setConfirmForget(null);
    const repoId = sshProjectId(target.host);
    const project = projectsRef.current.find((p) => p.id === repoId);
    const dirIds = target.dirId ? [target.dirId] : (project?.worktrees.map((w) => w.id) ?? []);
    const remote = tmuxOn(target.host, { onlyIfConnected: project?.ssh?.needsPassword });
    await Promise.all(dirIds.map((id) => remote.killSession(tmuxSessionName(repoId, id)).catch(() => {})));
    try {
      if (target.dirId) await removeRemoteDir(state, target.host, target.dirId);
      else await removeHost(state, target.host);
      const newProjects = await reconcile(state);
      setProjects(newProjects);
      const isGone = (o: { repoId: string; worktreeId: string }) => o.repoId === repoId && dirIds.includes(o.worktreeId);
      const remaining = opened.filter((o) => !isGone(o));
      setOpened(remaining);
      const wasOpen = openRef.current;
      if (wasOpen && isGone(wasOpen)) {
        setOpen(remaining[remaining.length - 1] ?? null);
        setFocusMode("sidebar");
      }
      const rows = buildRows(newProjects, collapsedRef.current);
      applyActiveIndex(Math.min(activeIndexRef.current, Math.max(rows.length - 1, 0)));
    } catch (err) {
      setNotice({ title: "Could not remove it", message: errText(err) });
    }
  };

  /** Ask for a new label for a worktree (the branch and directory keep their names). */
  const requestRename = (repoId: string, worktreeId: string) => {
    const worktree = projectsRef.current
      .find((p) => p.id === repoId)
      ?.worktrees.find((w) => w.id === worktreeId);
    if (!worktree) return;
    setFocusMode("sidebar");
    setRenaming({
      repoId,
      worktreeId,
      label: displayName(worktree),
      name: worktree.name,
      branch: worktree.branch || worktree.subtitle || worktree.path,
    });
  };

  /** Save a worktree's label (blank clears it) and show it straight away. */
  const saveLabel = (label: string) => {
    const target = renamingRef.current;
    if (!target) return;
    renamingRef.current = null;
    setRenaming(null);
    // Saving it as the branch's own name just clears the label.
    const next = label === target.name ? undefined : label;
    void setWorktreeLabel(state, target.repoId, target.worktreeId, next)
      .then((stored) => {
        setProjects((prev) =>
          prev.map((p) =>
            p.id !== target.repoId
              ? p
              : {
                  ...p,
                  worktrees: p.worktrees.map((w) =>
                    w.id !== target.worktreeId ? w : { ...w, label: stored },
                  ),
                },
          ),
        );
      })
      .catch((err) => setNotice({ title: "Could not save the label", message: errText(err) }));
  };

  /** Ask to merge the PR on screen; the prompt picks a method and confirms first. */
  const requestMerge = () => {
    const current = currentPrRef.current;
    if (!current) return;
    setFocusMode("sidebar"); // keys go to the prompt, not a terminal
    setMerging(current);
  };

  useKeyboard((key) => {
    // Help overlay is top-most: esc / ? / q close it, everything else is inert.
    if (helpOpenRef.current) {
      if (key.name === "escape" || key.name === "?" || key.name === "q") {
        setHelpOpen(false);
      }
      return;
    }

    // The modal owns the keyboard while open; App nav stays inert.
    if (modalOpenRef.current) return;

    // The close-worktree confirm/error and rename overlays own the keyboard while open.
    if (
      confirmCloseRef.current ||
      confirmForgetRef.current ||
      noticeRef.current ||
      renamingRef.current ||
      mergingRef.current ||
      sshModalRef.current
    )
      return;

    // While a terminal is focused, TerminalView owns the keyboard (input +
    // Ctrl+g to return + Alt tab chords). App nav stays inert.
    if (focusModeRef.current === "terminal") return;

    // Sidebar focus: Ctrl+C (or q) quits the app. In terminal focus these go to
    // the shell instead (handled by the early return above).
    if ((key.ctrl && key.name === "c") || key.name === "q") {
      quit();
      return;
    }

    const rows = buildRows(projectsRef.current, collapsedRef.current);
    const i = activeIndexRef.current;
    const row = rows[i];

    if (key.name === "n") {
      openAdd(null);
      return;
    }
    if (key.name === "s") {
      setSshModal({});
      return;
    }
    if (key.name === "a") {
      // Add a worktree to the currently-focused project (preselected).
      if (row) openAddForProject(row.project.id);
      return;
    }
    if (key.name === "[" || key.name === "]") {
      const step = key.name === "]" ? SIDEBAR_WIDTH_STEP : -SIDEBAR_WIDTH_STEP;
      applySidebarWidth(sidebarWidthRef.current + step);
      persistSidebarWidth();
      return;
    }
    if (key.name === "=") {
      resetSidebarWidth();
      return;
    }
    // PR panel: toggle, open on GitHub, refresh, scroll.
    if (key.name === "p") {
      togglePrPanel();
      return;
    }
    if (key.name === "o") {
      const current = currentPrRef.current;
      if (current) openExternal(current.pr.url);
      return;
    }
    if (key.name === "m") {
      requestMerge();
      return;
    }
    if (key.name === "r" && key.shift) {
      // R: rename (label) the selected worktree.
      if (row?.kind === "worktree") requestRename(row.project.id, row.worktree.id);
      return;
    }
    if (key.name === "r") {
      prPanelRef.current?.refresh();
      lastPrInvalidation.current = Date.now();
      void queryClient.invalidateQueries({ queryKey: queryKeys.allPrForBranch });
      return;
    }
    if (key.name === "pagedown" || key.name === "pageup") {
      prPanelRef.current?.scroll(key.name === "pagedown" ? 10 : -10);
      return;
    }
    if (key.name === "t") {
      cycleTheme();
      return;
    }
    if (key.name === "b") {
      if (sidebarHiddenRef.current) applySidebarHidden(false);
      else hideSidebar();
      return;
    }
    if (key.name === "?") {
      setHelpOpen(true);
      return;
    }
    if (key.name === "d") {
      requestCloseWorktree(row);
      return;
    }

    if (key.name === "down" || key.name === "j") {
      applyActiveIndex(Math.min(i + 1, rows.length - 1));
    } else if (key.name === "up" || key.name === "k") {
      applyActiveIndex(Math.max(i - 1, 0));
    } else if (key.name === "g" && !key.shift) {
      applyActiveIndex(0);
    } else if (key.name === "g" && key.shift) {
      // Shift+G arrives as name "g" with the shift flag, never as "G".
      applyActiveIndex(rows.length - 1);
    } else if (key.name === "space") {
      if (row) {
        const id = row.project.id;
        setCollapsedFor(id, !collapsedRef.current.has(id));
      }
    } else if (key.name === "left" || key.name === "h") {
      if (row) setCollapsedFor(row.project.id, true);
    } else if (key.name === "right" || key.name === "l") {
      if (row) setCollapsedFor(row.project.id, false);
    } else if (key.name === "return") {
      // Enter on a project header folds it; on a worktree it opens its terminal.
      if (row && row.kind === "project") {
        const id = row.project.id;
        setCollapsedFor(id, !collapsedRef.current.has(id));
      } else if (row && row.kind === "worktree" && !row.worktree.missing) {
        openWorktreeTerminal(row.project.id, row.worktree.id);
      }
    }
  });

  const rows = buildRows(viewProjects, collapsed);
  const active = rows[Math.min(activeIndex, rows.length - 1)];
  const activeKey = active ? rowKey(active) : "";

  // Resolve every mounted worktree that still exists on disk. Their terminals
  // all stay rendered; only the `open` one is visible (see `opened`).
  const activeTermKey = open ? `${open.repoId}:${open.worktreeId}` : null;
  const mounted = opened
    .map((o) => {
      const project = viewProjects.find((p) => p.id === o.repoId);
      const worktree = project?.worktrees.find(
        (w) => w.id === o.worktreeId && !w.missing,
      );
      return project && worktree
        ? { key: `${o.repoId}:${o.worktreeId}`, repoId: o.repoId, worktree }
        : null;
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  // Show the placeholder pane only when no mounted terminal is the visible one.
  const showMain = !mounted.some((m) => m.key === activeTermKey);

  // The PR panel follows the worktree on screen: the open terminal's, or the
  // selected row's when no terminal is showing.
  const onScreen = mounted.find((m) => m.key === activeTermKey) ??
    (active?.kind === "worktree" ? { repoId: active.project.id, worktree: active.worktree } : null);
  const currentPr = onScreen?.worktree.pr
    ? { repo: onScreen.repoId, pr: onScreen.worktree.pr }
    : null;
  currentPrRef.current = currentPr;
  const layout = fitPanels(screenWidth, sidebarWidth, prPanelWidth, !prPanelHidden && !!currentPr, sidebarHidden);
  layoutRef.current = layout;

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.bg}>
      {!sidebarHidden && (
        <Sidebar
          projects={viewProjects}
          collapsed={collapsed}
          activeKey={activeKey}
          onAddWorktree={openAddForProject}
          onClickWorktree={clickWorktree}
          onRenameWorktree={requestRename}
          onFocus={() => setFocusMode("sidebar")}
          onSelectProject={selectProject}
          onCycleTheme={() => cycleTheme()}
          onHelp={() => setHelpOpen(true)}
          width={layout.sidebar}
          onResize={applySidebarWidth}
          onResizeEnd={() => persistSidebarWidth()}
          onResetWidth={resetSidebarWidth}
          onHide={hideSidebar}
        />
      )}
      <box flexGrow={1} flexDirection="column" backgroundColor={theme.bg}>
        {mounted.map((m) => {
          const isActive = m.key === activeTermKey;
          return (
            <TerminalPane
              key={m.key}
              repoId={m.repoId}
              worktree={m.worktree}
              visible={isActive}
              focused={isActive && focusMode === "terminal"}
              onRequestFocus={() => setFocusMode("terminal")}
              onExit={exitToSidebar}
              prPanelShown={layout.panel > 0}
              onTogglePrPanel={togglePrPanel}
              diffViewer={diffViewer}
              onDiffViewer={chooseDiffViewer}
            />
          );
        })}
        {showMain && <MainPane row={active} sidebarHidden={sidebarHidden} />}
      </box>
      {layout.panel > 0 && currentPr && (
        <PrPanel
          repo={currentPr.repo}
          pr={currentPr.pr}
          width={layout.panel}
          onResize={applyPrPanelWidth}
          onResizeEnd={persistPrPanelWidth}
          onResetWidth={resetPrPanelWidth}
          onClose={togglePrPanel}
          onMerge={requestMerge}
          collapsed={prCollapsed}
          onToggleSection={togglePrSection}
          handleRef={prPanelRef}
        />
      )}
      {modalOpen && (
        <AddWorktreeModal
          state={state}
          preselect={preselect}
          onClose={() => {
            setModalOpen(false);
            setPreselect(null);
          }}
          onApplied={handleApplied}
        />
      )}
      {helpOpen && (
        <HelpOverlay themeName={theme.name} onClose={() => setHelpOpen(false)} />
      )}
      {confirmClose && (
        <ConfirmModal
          title="Close worktree"
          message={`Delete ${confirmClose.what} from disk? This cannot be undone.`}
          detail={
            confirmClose.missing
              ? "Already gone on disk — this only forgets it."
              : confirmClose.dirty
                ? "It has uncommitted changes, which will be lost."
                : undefined
          }
          onConfirm={() => void performCloseWorktree()}
          onCancel={() => setConfirmClose(null)}
        />
      )}
      {confirmForget && (
        <ConfirmModal
          title={confirmForget.dirId ? "Remove directory" : "Remove host"}
          message={
            confirmForget.dirId
              ? `Remove ${confirmForget.what} on ${confirmForget.host} from agentree?`
              : `Remove ${confirmForget.host} and its directories from agentree?`
          }
          detail={
            confirmForget.needsPassword
              ? "Their tmux sessions on the host end if agentree is connected to it right now (it logs in with a password); no files are touched."
              : "Their tmux sessions on the host end (and anything running in them); no files are touched."
          }
          onConfirm={() => void performForget()}
          onCancel={() => setConfirmForget(null)}
        />
      )}
      {sshModal && (
        <SshModal
          state={state}
          host={sshModal.host}
          onClose={() => setSshModal(null)}
          onAdded={handleApplied}
        />
      )}
      {merging && (
        <MergeModal
          repo={merging.repo}
          pr={merging.pr}
          preferred={state.ui?.mergeMethod}
          onMerged={(method) => saveUi({ mergeMethod: method })}
          onClose={() => setMerging(null)}
        />
      )}
      {renaming && (
        <RenameModal
          initial={renaming.label}
          heading={`Label for ${renaming.branch}`}
          placeholder={renaming.name}
          note="Only the label changes — the branch and folder keep their names. Empty goes back to the branch name."
          maxLength={MAX_LABEL_LENGTH}
          onSave={saveLabel}
          onCancel={() => setRenaming(null)}
        />
      )}
      {notice && (
        <ConfirmModal
          title={notice.title}
          message={notice.message}
          onCancel={() => setNotice(null)}
        />
      )}
    </box>
  );
}
