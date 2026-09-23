import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { existsSync } from "node:fs";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme, cycleTheme } from "./theme";
import type { AgentStatus, Project, Worktree } from "./data/model";
import { removeWorktree, status as gitStatus, type WorktreeStatus } from "./services/git";
import { readAgentStatuses } from "./services/agents";
import { killSession, sessionName as tmuxSessionName } from "./services/tmux";
import { prForBranch } from "./services/gh";
import { Sidebar, projectKey, worktreeKey } from "./components/Sidebar";
import {
  AddWorktreeModal,
  type PreselectRepo,
  type Selection,
} from "./components/AddWorktreeModal";
import { reconcile, removeManagedWorktree, saveState, type State, type UiState } from "./store";
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
import { PrPanel, type PrPanelHandle } from "./components/PrPanel";
import { openExternal } from "./services/open";
import type { PrInfo } from "./data/model";
import { ConfirmModal } from "./components/ConfirmModal";

function MainPane({ row }: { row: Row | undefined }) {
  const theme = useTheme();
  const label = !row
    ? "agentree"
    : row.kind === "worktree"
      ? row.worktree.name
      : row.project.name;
  const subtitle =
    row?.kind === "worktree"
      ? row.worktree.path
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
        {"tmux session would render here"}
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

/** How often git status is refreshed in the background. */
const GIT_STATUS_POLL_MS = 5000;
/** How often agent status is read. */
const AGENT_POLL_MS = 1000;
/** How often every worktree's PR is looked up again. */
const PR_LOOKUP_MS = 60_000;
/** At most one extra PR lookup this often (agent state changes come in bursts). */
const PR_LOOKUP_THROTTLE_MS = 15_000;

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

function sameGitStatus(w: Worktree, st: WorktreeStatus): boolean {
  return (
    w.dirty === st.dirty &&
    w.changed === st.changed &&
    w.added === st.added &&
    w.removed === st.removed &&
    w.ahead === st.ahead &&
    w.behind === st.behind
  );
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export interface AppProps {
  initialProjects: Project[];
  state: State;
  /** Leave the app. Injected so tests can assert a quit without exiting the runner. */
  onQuit?: () => void;
}

export function App({ initialProjects, state, onQuit }: AppProps) {
  const theme = useTheme();
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
  // Pending "close worktree" confirmation (d key), and a surfaced error if it fails.
  const [confirmClose, setConfirmClose] = useState<{
    repoId: string;
    worktreeId: string;
    name: string;
    dirty: boolean;
    missing: boolean;
  } | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
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
  const [prPanelWidth, setPrPanelWidth] = useState(
    () => state.ui?.prPanelWidth ?? DEFAULT_PR_PANEL_WIDTH,
  );
  const prPanelRef = useRef<PrPanelHandle | null>(null);
  /** The PR on screen (set while rendering), for the key handler. */
  const currentPrRef = useRef<{ repo: string; pr: PrInfo } | null>(null);
  /** The rendered side-panel widths (set while rendering). */
  const layoutRef = useRef({ sidebar: 0, panel: 0 });

  // Refs mirror state so the keyboard handler always reads current values.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
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
  const closeErrorRef = useRef(closeError);
  closeErrorRef.current = closeError;
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const screenWidthRef = useRef(screenWidth);
  screenWidthRef.current = screenWidth;
  const prPanelHiddenRef = useRef(prPanelHidden);
  prPanelHiddenRef.current = prPanelHidden;
  const prPanelWidthRef = useRef(prPanelWidth);
  prPanelWidthRef.current = prPanelWidth;

  // Git status (dirty, changed files, +/−, ahead/behind) for on-disk worktrees:
  // on start, every GIT_STATUS_POLL_MS, and right away when an agent changes
  // state (it has probably just touched files). It used to be computed once at
  // startup, so it drifted from reality as agents edited and committed.
  const pathSig = projects
    .flatMap((p) => p.worktrees.filter((w) => !w.missing).map((w) => w.path))
    .join("|");
  // Background loops stop once the app is gone (a test disposing it, say).
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const gitStatusInFlight = useRef(false);
  const refreshGitStatus = useRef(() => {});
  refreshGitStatus.current = () => {
    if (gitStatusInFlight.current) return;
    gitStatusInFlight.current = true;
    const targets = projectsRef.current.flatMap((p) =>
      p.worktrees
        .filter((w) => !w.missing)
        .map((w) => ({ repoId: p.id, id: w.id, path: w.path })),
    );
    (async () => {
      const limit = 4;
      for (let i = 0; i < targets.length && alive.current; i += limit) {
        const batch = targets.slice(i, i + limit);
        const results = await Promise.all(
          batch.map(async (t) => ({
            t,
            st: await gitStatus(t.path).catch(() => null),
          })),
        );
        if (!alive.current) return;
        // Only re-render when something actually changed.
        setProjects((prev) => {
          let changed = false;
          const next = prev.map((p) => ({
            ...p,
            worktrees: p.worktrees.map((w) => {
              const hit = results.find(
                (r) => r.st && r.t.repoId === p.id && r.t.id === w.id,
              );
              if (!hit?.st || sameGitStatus(w, hit.st)) return w;
              changed = true;
              return { ...w, ...hit.st };
            }),
          }));
          return changed ? next : prev;
        });
      }
    })().finally(() => {
      gitStatusInFlight.current = false;
    });
  };
  useEffect(() => {
    refreshGitStatus.current();
    const id = setInterval(() => refreshGitStatus.current(), GIT_STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [pathSig]);

  // Live agent status per tmux session (services/agents): what the agents'
  // hooks report, corrected by tmux, with "done" shown as "idle" once you've
  // had that worktree's terminal on screen.
  const [agentStatus, setAgentStatus] = useState<Record<string, AgentStatus>>({});
  /** When each session's terminal was last on screen (epoch seconds). */
  const seenAt = useRef(new Map<string, number>());
  /** Last raw report per session, to spot state changes. */
  const lastReports = useRef(new Map<string, string>());
  const agentPollInFlight = useRef(false);
  const pollAgents = useRef(() => {});
  pollAgents.current = () => {
    if (agentPollInFlight.current || !alive.current) return;
    agentPollInFlight.current = true;
    const now = Math.floor(Date.now() / 1000);
    readAgentStatuses(now)
      .then((reports) => {
        const visible = openRef.current;
        if (visible) {
          seenAt.current.set(tmuxSessionName(visible.repoId, visible.worktreeId), now);
        }
        const next: Record<string, AgentStatus> = {};
        const raw = new Map<string, string>();
        let transitioned = reports.size !== lastReports.current.size;
        for (const [session, r] of reports) {
          const key = `${r.state} ${r.since}`;
          raw.set(session, key);
          if (lastReports.current.get(session) !== key) transitioned = true;
          const seen = (seenAt.current.get(session) ?? 0) >= r.since;
          next[session] = r.state === "done" && seen ? "idle" : r.state;
        }
        lastReports.current = raw;
        setAgentStatus((prev) => (sameRecord(prev, next) ? prev : next));
        if (transitioned) {
          refreshGitStatus.current();
          refreshPrsSoon();
        }
      })
      .catch(() => {})
      .finally(() => {
        agentPollInFlight.current = false;
      });
  };
  useEffect(() => {
    const id = setInterval(() => pollAgents.current(), AGENT_POLL_MS);
    return () => clearInterval(id);
  }, []);
  // Opening a worktree marks its "done" as seen now, not on the next tick.
  useEffect(() => {
    pollAgents.current();
  }, [open]);

  // The open PR for each worktree's branch: on start, again every PR_LOOKUP_MS,
  // when an agent changes state (it may have just opened or pushed to one), and
  // on `r`. It used to be looked up once and cached for the whole session.
  const prSig = projects
    .flatMap((p) =>
      p.worktrees
        .filter((w) => !w.missing && w.branch && w.branch !== "(detached)")
        .map((w) => `${p.id}:${w.id}:${w.branch}`),
    )
    .join("|");
  const prLookupInFlight = useRef(false);
  const prLookupQueued = useRef<boolean | null>(null);
  const lastForcedPrLookup = useRef(0);
  const refreshPrs = useRef((_force: boolean) => {});
  refreshPrs.current = (force) => {
    if (prLookupInFlight.current) {
      // Run again when this one finishes (a new worktree needs its lookup).
      prLookupQueued.current = (prLookupQueued.current ?? false) || force;
      return;
    }
    prLookupInFlight.current = true;
    const targets = projectsRef.current.flatMap((p) =>
      p.worktrees
        .filter((w) => !w.missing && w.branch && w.branch !== "(detached)")
        .map((w) => ({ repoId: p.id, id: w.id, branch: w.branch })),
    );
    (async () => {
      const limit = 4;
      for (let i = 0; i < targets.length && alive.current; i += limit) {
        const batch = targets.slice(i, i + limit);
        const results = await Promise.all(
          batch.map(async (t) => ({
            t,
            pr: await prForBranch(t.repoId, t.branch, force).catch(() => null),
          })),
        );
        if (!alive.current) return;
        setProjects((prev) => {
          let changed = false;
          const next = prev.map((p) => ({
            ...p,
            worktrees: p.worktrees.map((w) => {
              const hit = results.find((r) => r.t.repoId === p.id && r.t.id === w.id);
              if (!hit || samePr(w.pr, hit.pr ?? undefined)) return w;
              changed = true;
              return { ...w, pr: hit.pr ?? undefined };
            }),
          }));
          return changed ? next : prev;
        });
      }
    })().finally(() => {
      prLookupInFlight.current = false;
      const queued = prLookupQueued.current;
      prLookupQueued.current = null;
      if (queued !== null && alive.current) refreshPrs.current(queued);
    });
  };
  useEffect(() => {
    refreshPrs.current(false);
  }, [prSig]);
  useEffect(() => {
    const id = setInterval(() => refreshPrs.current(true), PR_LOOKUP_MS);
    return () => clearInterval(id);
  }, []);
  /** A forced lookup, at most once per PR_LOOKUP_THROTTLE_MS. */
  const refreshPrsSoon = () => {
    const now = Date.now();
    if (now - lastForcedPrLookup.current < PR_LOOKUP_THROTTLE_MS) return;
    lastForcedPrLookup.current = now;
    refreshPrs.current(true);
  };

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

  /** Show / hide the PR panel (`p`, ⌥p, its ✕, or the tab bar's PR button). */
  const togglePrPanel = () => {
    const hidden = !prPanelHiddenRef.current;
    prPanelHiddenRef.current = hidden;
    setPrPanelHidden(hidden);
    saveUi({ prPanelHidden: hidden || undefined });
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

  /** Click a project header: return focus to the sidebar and toggle its fold. */
  const selectProject = (projectId: string) => {
    setFocusMode("sidebar");
    setCollapsedFor(projectId, !collapsedRef.current.has(projectId));
  };

  /** Ask to close (delete from disk) the worktree under the cursor. */
  const requestCloseWorktree = (row: Row | undefined) => {
    if (!row || row.kind !== "worktree") return;
    if (row.worktree.id === "main") {
      setCloseError(
        "The main working copy can't be closed this way — remove the project instead.",
      );
      return;
    }
    setConfirmClose({
      repoId: row.project.id,
      worktreeId: row.worktree.id,
      name: row.worktree.name,
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
      setCloseError(err instanceof Error ? err.message : String(err));
    }
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

    // The close-worktree confirm/error overlays own the keyboard while open.
    if (confirmCloseRef.current || closeErrorRef.current) return;

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
    if (key.name === "r") {
      prPanelRef.current?.refresh();
      lastForcedPrLookup.current = Date.now();
      refreshPrs.current(true);
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

  // What the sidebar shows: projects with each worktree's live agent status.
  const viewProjects = useMemo(
    () =>
      projects.map((p) => ({
        ...p,
        worktrees: p.worktrees.map((w) => {
          const agent = agentStatus[tmuxSessionName(p.id, w.id)] ?? "none";
          return agent === w.agent ? w : { ...w, agent };
        }),
      })),
    [projects, agentStatus],
  );

  const rows = buildRows(projects, collapsed);
  const active = rows[Math.min(activeIndex, rows.length - 1)];
  const activeKey = active ? rowKey(active) : "";

  // Resolve every mounted worktree that still exists on disk. Their terminals
  // all stay rendered; only the `open` one is visible (see `opened`).
  const activeTermKey = open ? `${open.repoId}:${open.worktreeId}` : null;
  const mounted = opened
    .map((o) => {
      const project = projects.find((p) => p.id === o.repoId);
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
  const layout = fitPanels(screenWidth, sidebarWidth, prPanelWidth, !prPanelHidden && !!currentPr);
  layoutRef.current = layout;

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.bg}>
      <Sidebar
        projects={viewProjects}
        collapsed={collapsed}
        activeKey={activeKey}
        onAddWorktree={openAddForProject}
        onOpenWorktree={openWorktreeTerminal}
        onSelectProject={selectProject}
        onCycleTheme={() => cycleTheme()}
        onHelp={() => setHelpOpen(true)}
        width={layout.sidebar}
        onResize={applySidebarWidth}
        onResizeEnd={() => persistSidebarWidth()}
        onResetWidth={resetSidebarWidth}
      />
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
              onExit={() => setFocusMode("sidebar")}
              prPanelShown={layout.panel > 0}
              onTogglePrPanel={togglePrPanel}
            />
          );
        })}
        {showMain && <MainPane row={active} />}
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
          message={`Delete "${confirmClose.name}" from disk? This cannot be undone.`}
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
      {closeError && (
        <ConfirmModal
          title="Could not close worktree"
          message={closeError}
          onCancel={() => setCloseError(null)}
        />
      )}
    </box>
  );
}
