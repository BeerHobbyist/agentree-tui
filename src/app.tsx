import { TextAttributes, type ParsedKey } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { existsSync } from "node:fs";
import { useEffect, useRef, useState } from "react";
import { QueryClientProvider, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { bindTerminalFocus, createQueryClient } from "./queryClient";
import { queryKeys } from "./queries";
import { setRemoteTracking, setTrackingEveryClaude } from "./services/agents";
import { useTheme, cycleTheme } from "./theme";
import { displayName, type AgentStatus, type PrInfo, type Project, type Worktree } from "./data/model";
import { removeWorktree } from "./services/git";
import { killSession, sessionName, tmuxOn } from "./services/tmux";
import { Sidebar, projectKey, worktreeKey } from "./components/Sidebar";
import type { Selection } from "./components/AddWorktreeModal";
import {
  reconcile,
  removeHost,
  removeManagedWorktree,
  removeRemoteDir,
  setWorktreeLabel,
  sshProjectId,
  type State,
} from "./store";
import { SIDEBAR_WIDTH_STEP, fitPanels } from "./layout";
import { TerminalPane } from "./components/TerminalPane";
import { PrPanel, type PrPanelHandle } from "./components/PrPanel";
import { openExternal } from "./services/open";
import { useLive, useMirror } from "./app/live";
import { OverlayLayer, useOverlays, type Overlay, type OverlayActions } from "./app/overlays";
import { usePrefs } from "./app/usePrefs";
import { useAgents } from "./app/useAgents";
import { useLiveProjects } from "./app/useLiveProjects";

function MainPane({ row, sidebarHidden }: { row: Row | undefined; sidebarHidden?: boolean }) {
  const theme = useTheme();
  const label = !row ? "agentree" : row.kind === "worktree" ? displayName(row.worktree) : row.project.name;
  const subtitle =
    row?.kind === "worktree"
      ? row.worktree.host
        ? `${row.worktree.host}:${row.worktree.subtitle ?? row.worktree.path}`
        : row.worktree.path
      : row?.kind === "project"
        ? row.project.root
        : "Press n to add a project";

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={theme.bg} alignItems="center" justifyContent="center">
      <ascii-font font="tiny" text={label} />
      <text fg={theme.fgMuted}>{subtitle}</text>
      <text fg={theme.fgFaint} attributes={TextAttributes.DIM}>
        {sidebarHidden ? "The sidebar is hidden — b shows it" : "tmux session would render here"}
      </text>
    </box>
  );
}

export type Row = { kind: "project"; project: Project } | { kind: "worktree"; project: Project; worktree: Worktree };

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
  return row.kind === "project" ? projectKey(row.project.id) : worktreeKey(row.project.id, row.worktree.id);
}

/**
 * The names a key goes by, most specific first: `C-c` for Ctrl+C, `R` for
 * Shift+R, then its plain name — so Shift or Ctrl with a letter that has no
 * binding of its own acts as the letter.
 */
export function keyIds(key: Pick<ParsedKey, "name" | "ctrl" | "shift">): string[] {
  const ids: string[] = [];
  if (key.ctrl) ids.push(`C-${key.name}`);
  if (key.shift && /^[a-z]$/.test(key.name)) ids.push(key.name.toUpperCase());
  ids.push(key.name);
  return ids;
}

/** Two clicks on the same worktree row within this count as a double-click. */
const DOUBLE_CLICK_MS = 400;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A worktree in a project — which terminal is where. */
type Pane = { repoId: string; worktreeId: string };

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
  const renderer = useRenderer();
  const queryClient = useQueryClient();
  const { width: screenWidth } = useTerminalDimensions();
  const screenWidthRef = useMirror(screenWidth);
  /** The rendered side-panel widths (set while rendering). */
  const layoutRef = useRef({ sidebar: 0, panel: 0 });

  // Everything the key handler reads is `useLive` state (see app/live.ts).
  const [projects, rawProjectsRef, setProjects] = useLive<Project[]>(initialProjects);
  const [collapsed, collapsedRef, setCollapsed] = useLive<Set<string>>(() => new Set());
  const [activeIndex, activeIndexRef, setActiveIndex] = useLive(0);
  // The worktree whose terminal is visible in the content pane, and where keys go.
  const [open, openRef, setOpen] = useLive<Pane | null>(null);
  // Every worktree opened at least once. Their terminals stay mounted (hidden)
  // so switching back is instant: re-attaching tmux would clear+redraw the
  // emulator, which reads as a flash. Only the `open` one is visible.
  const [opened, openedRef, setOpened] = useLive<Pane[]>([]);
  const [focusMode, focusModeRef, setFocusMode] = useLive<"sidebar" | "terminal">("sidebar");
  const overlays = useOverlays();
  const prefs = usePrefs(state, screenWidthRef, layoutRef);
  const prPanelRef = useRef<PrPanelHandle | null>(null);
  /** The PR on screen (set while rendering), for the key handler. */
  const currentPrRef = useRef<{ repo: string; pr: PrInfo } | null>(null);
  /** The projects as shown — live status merged in — for the handlers. */
  const projectsRef = useRef(projects);

  const agents = useAgents(projects, opened, open, projectsRef);
  const { viewProjects, refreshPrs } = useLiveProjects(projects, agents.status, agents.reports);
  projectsRef.current = viewProjects;

  const notice = (title: string, err: unknown) => overlays.open({ kind: "notice", title, message: errText(err) });

  // ── Selection, folding, opening terminals ──

  /** Select a worktree's row (in `projects`, as folded by `folded`). */
  const selectWorktreeRow = (
    repoId: string,
    worktreeId: string,
    list = projectsRef.current,
    folded = collapsedRef.current,
  ) => {
    const idx = buildRows(list, folded).findIndex(
      (r) => r.kind === "worktree" && r.project.id === repoId && r.worktree.id === worktreeId,
    );
    if (idx >= 0) setActiveIndex(idx);
  };

  const setCollapsedFor = (projectId: string, wantCollapsed: boolean) => {
    const next = new Set(collapsedRef.current);
    if (wantCollapsed) next.add(projectId);
    else next.delete(projectId);
    setCollapsed(next);
    // Keep the selection valid: snap to the project header in the new layout.
    const idx = buildRows(projectsRef.current, next).findIndex(
      (r) => r.kind === "project" && r.project.id === projectId,
    );
    if (idx >= 0) setActiveIndex(idx);
  };
  const toggleFold = (projectId: string) => setCollapsedFor(projectId, !collapsedRef.current.has(projectId));

  /** Record a worktree as opened so its terminal stays mounted across switches. */
  const markOpened = (repoId: string, worktreeId: string) => {
    const list = openedRef.current;
    if (!list.some((o) => o.repoId === repoId && o.worktreeId === worktreeId))
      setOpened([...list, { repoId, worktreeId }]);
  };

  /** Open (mount + focus) a worktree's terminal — Enter, a double-click. */
  const openWorktreeTerminal = (repoId: string, worktreeId: string) => {
    markOpened(repoId, worktreeId);
    setOpen({ repoId, worktreeId });
    setFocusMode("terminal");
    selectWorktreeRow(repoId, worktreeId);
  };

  /**
   * Select a worktree and show its terminal, keeping the keyboard in the
   * sidebar (a click on its row). A worktree that's gone on disk is only selected.
   */
  const showWorktree = (repoId: string, worktreeId: string) => {
    const worktree = projectsRef.current.find((p) => p.id === repoId)?.worktrees.find((w) => w.id === worktreeId);
    if (worktree && !worktree.missing) {
      markOpened(repoId, worktreeId);
      setOpen({ repoId, worktreeId });
    }
    setFocusMode("sidebar");
    selectWorktreeRow(repoId, worktreeId);
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
    toggleFold(projectId);
  };

  /**
   * Go to the next agent that needs you — or, with none, the next that's done —
   * after the one on screen, in sidebar order (Tab, ⌥n, or a footer count for
   * that state). Its terminal opens with the keys, ready for an answer.
   */
  const jumpToNext = (only?: AgentStatus) => {
    const all = projectsRef.current.flatMap((p) =>
      p.worktrees.filter((w) => !w.missing).map((w) => ({ repoId: p.id, worktreeId: w.id, agent: w.agent })),
    );
    const here = openRef.current;
    const from = here ? all.findIndex((o) => o.repoId === here.repoId && o.worktreeId === here.worktreeId) : -1;
    for (const state of only ? [only] : (["needs-action", "done"] as AgentStatus[])) {
      const candidates = all.map((o, i) => ({ o, i })).filter(({ o }) => o.agent === state);
      if (candidates.length === 0) continue;
      const { o } = candidates.find(({ i }) => i > from) ?? candidates[0]!;
      if (collapsedRef.current.has(o.repoId)) {
        const next = new Set(collapsedRef.current);
        next.delete(o.repoId);
        setCollapsed(next);
      }
      openWorktreeTerminal(o.repoId, o.worktreeId);
      return;
    }
  };

  /** Hide the sidebar (`b`, its ⇤): the keys go to the terminal on screen, if there is one. */
  const hideSidebar = () => {
    prefs.sidebar.setHidden(true);
    if (openRef.current) setFocusMode("terminal");
  };

  /** Back to the sidebar (Ctrl+g, the tab bar's ‹) — showing it if it was hidden. */
  const exitToSidebar = () => {
    if (prefs.sidebar.hiddenRef.current) prefs.sidebar.setHidden(false);
    setFocusMode("sidebar");
  };

  const quit = () => {
    try {
      renderer.destroy();
    } catch {
      // fall through to hard exit
    }
    if (onQuit) onQuit();
    else process.exit(0);
  };

  // ── Adding, removing, renaming ──

  /** A worktree (or SSH directory) was added: show it, selected, its terminal mounted. */
  const onApplied = (newProjects: Project[], sel: Selection) => {
    overlays.close("add");
    overlays.close("ssh");
    setProjects(newProjects);
    const nextCollapsed = new Set(collapsedRef.current);
    nextCollapsed.delete(sel.repoId);
    setCollapsed(nextCollapsed);
    selectWorktreeRow(sel.repoId, sel.worktreeId, newProjects, nextCollapsed);
    // Mount its terminal so the content pane matches the sidebar selection.
    // Focus stays on the sidebar (unlike Enter/click), so keyboard shortcuts
    // keep working right after the modal closes.
    markOpened(sel.repoId, sel.worktreeId);
    setOpen({ repoId: sel.repoId, worktreeId: sel.worktreeId });
  };

  /** `a` / a header's ＋: add a worktree to that project (or a directory, on an SSH host). */
  const openAddForProject = (projectId: string) => {
    const proj = projectsRef.current.find((p) => p.id === projectId);
    if (!proj) return;
    if (proj.ssh) {
      setFocusMode("sidebar");
      overlays.open({ kind: "ssh", host: proj.ssh.host });
      return;
    }
    overlays.open({ kind: "add", preselect: { nameWithOwner: proj.id, name: proj.name, root: proj.root } });
  };

  /** `d`: ask to close (delete) the worktree under the cursor — or forget an SSH directory / host. */
  const requestClose = (row: Row | undefined) => {
    if (row?.project.ssh) {
      const { host, needsPassword } = row.project.ssh;
      overlays.open(
        row.kind === "worktree"
          ? {
              kind: "forget",
              host,
              dirId: row.worktree.id,
              what: row.worktree.subtitle ?? row.worktree.path,
              needsPassword,
            }
          : { kind: "forget", host, what: host, needsPassword },
      );
      return;
    }
    if (row?.kind !== "worktree") return;
    if (row.worktree.id === "main") {
      overlays.open({
        kind: "notice",
        title: "Could not close worktree",
        message: "The main working copy can't be closed this way — remove the project instead.",
      });
      return;
    }
    overlays.open({
      kind: "close-worktree",
      repoId: row.project.id,
      worktreeId: row.worktree.id,
      what: row.worktree.label ? `"${row.worktree.label}" (${row.worktree.branch})` : `"${row.worktree.name}"`,
      dirty: row.worktree.dirty,
      missing: !!row.worktree.missing,
    });
  };

  /**
   * After worktrees went away: the new project list, their terminals unmounted
   * (tearing down their PTYs), another one shown if one of them was on screen,
   * and the selection kept in range.
   */
  const afterRemoval = (newProjects: Project[], gone: (o: Pane) => boolean) => {
    setProjects(newProjects);
    const remaining = openedRef.current.filter((o) => !gone(o));
    setOpened(remaining);
    const wasOpen = openRef.current;
    if (wasOpen && gone(wasOpen)) {
      setOpen(remaining.at(-1) ?? null);
      setFocusMode("sidebar");
    }
    const rows = buildRows(newProjects, collapsedRef.current);
    setActiveIndex(Math.min(activeIndexRef.current, Math.max(rows.length - 1, 0)));
  };

  /** Kill its tmux session, delete it on disk (unless already missing), and drop it from state. */
  const closeWorktree = async (target: Extract<Overlay, { kind: "close-worktree" }>) => {
    overlays.close("close-worktree");
    try {
      const project = projectsRef.current.find((p) => p.id === target.repoId);
      const wt = project?.worktrees.find((w) => w.id === target.worktreeId);
      // `--force` also cleans up a worktree whose directory is already gone —
      // git still tracks it as "prunable" until told to remove it, and
      // leaving that behind would make reconcile() re-adopt it right back.
      if (project && wt && existsSync(project.root)) {
        await killSession(sessionName(target.repoId, target.worktreeId)).catch(() => {});
        await removeWorktree(project.root, wt.path, { force: true });
      }
      await removeManagedWorktree(state, target.repoId, target.worktreeId);
      afterRemoval(await reconcile(state), (o) => o.repoId === target.repoId && o.worktreeId === target.worktreeId);
    } catch (err) {
      notice("Could not close worktree", err);
    }
  };

  /**
   * Forget an SSH directory (or a whole host): end its tmux session(s) on the
   * host and drop it from state. Nothing on the host is deleted.
   */
  const forget = async (target: Extract<Overlay, { kind: "forget" }>) => {
    overlays.close("forget");
    const repoId = sshProjectId(target.host);
    const project = projectsRef.current.find((p) => p.id === repoId);
    const dirIds = target.dirId ? [target.dirId] : (project?.worktrees.map((w) => w.id) ?? []);
    const remote = tmuxOn(target.host, { onlyIfConnected: project?.ssh?.needsPassword });
    await Promise.all(dirIds.map((id) => remote.killSession(sessionName(repoId, id)).catch(() => {})));
    try {
      if (target.dirId) await removeRemoteDir(state, target.host, target.dirId);
      else await removeHost(state, target.host);
      afterRemoval(await reconcile(state), (o) => o.repoId === repoId && dirIds.includes(o.worktreeId));
    } catch (err) {
      notice("Could not remove it", err);
    }
  };

  /** Ask for a new label for a worktree (the branch and directory keep their names). */
  const requestRename = (repoId: string, worktreeId: string) => {
    const worktree = projectsRef.current.find((p) => p.id === repoId)?.worktrees.find((w) => w.id === worktreeId);
    if (!worktree) return;
    setFocusMode("sidebar");
    overlays.open({
      kind: "rename",
      repoId,
      worktreeId,
      label: displayName(worktree),
      name: worktree.name,
      branch: worktree.branch || worktree.subtitle || worktree.path,
    });
  };

  /** Save a worktree's label (blank clears it) and show it straight away. */
  const saveLabel = (target: Extract<Overlay, { kind: "rename" }>, label: string) => {
    overlays.close("rename");
    // Saving it as the branch's own name just clears the label.
    const next = label === target.name ? undefined : label;
    void setWorktreeLabel(state, target.repoId, target.worktreeId, next)
      .then((stored) => {
        setProjects(
          rawProjectsRef.current.map((p) =>
            p.id !== target.repoId
              ? p
              : { ...p, worktrees: p.worktrees.map((w) => (w.id !== target.worktreeId ? w : { ...w, label: stored })) },
          ),
        );
      })
      .catch((err) => notice("Could not save the label", err));
  };

  /** Ask to merge the PR on screen; the prompt picks a method and confirms first. */
  const requestMerge = () => {
    const current = currentPrRef.current;
    if (!current) return;
    setFocusMode("sidebar"); // keys go to the prompt, not a terminal
    overlays.open({ kind: "merge", ...current });
  };

  /** Track every claude, or stop: agentree's hooks in Claude's user settings, here and on open SSH hosts. */
  const setTracking = (on: boolean) => {
    overlays.close("tracking");
    try {
      setTrackingEveryClaude(on);
    } catch (err) {
      notice("Couldn't change Claude's settings", err);
      return;
    }
    agents.hookedHosts.current.clear();
    for (const h of agents.remoteHosts) {
      void setRemoteTracking(h.host, on, { onlyIfConnected: h.needsPassword }).then((result) => {
        if (on && result !== "unreachable") agents.hookedHosts.current.add(h.host);
      });
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.tracking });
  };

  // ── Keys (while the sidebar has them) ──

  /** What each key does in the sidebar; `row` is the selected one. See keyIds for the names. */
  const sidebarKeys: Record<string, (row: Row | undefined, rows: Row[], i: number) => void> = {
    q: quit,
    "C-c": quit,
    n: () => overlays.open({ kind: "add", preselect: null }),
    s: () => overlays.open({ kind: "ssh" }),
    a: (row) => row && openAddForProject(row.project.id),
    d: (row) => requestClose(row),
    R: (row) => row?.kind === "worktree" && requestRename(row.project.id, row.worktree.id),
    H: () => overlays.open({ kind: "tracking", on: !agents.tracking }),
    tab: () => jumpToNext(),
    "[": () => {
      prefs.sidebar.resize(prefs.sidebar.widthRef.current - SIDEBAR_WIDTH_STEP);
      prefs.sidebar.persistWidth();
    },
    "]": () => {
      prefs.sidebar.resize(prefs.sidebar.widthRef.current + SIDEBAR_WIDTH_STEP);
      prefs.sidebar.persistWidth();
    },
    "=": () => prefs.sidebar.resetWidth(),
    b: () => (prefs.sidebar.hiddenRef.current ? prefs.sidebar.setHidden(false) : hideSidebar()),
    // The PR panel: toggle, open on GitHub, merge, refresh, scroll.
    p: () => prefs.prPanel.toggle(),
    o: () => currentPrRef.current && openExternal(currentPrRef.current.pr.url),
    m: requestMerge,
    r: () => {
      prPanelRef.current?.refresh();
      refreshPrs();
    },
    pagedown: () => prPanelRef.current?.scroll(10),
    pageup: () => prPanelRef.current?.scroll(-10),
    t: () => cycleTheme(),
    "?": () => overlays.open({ kind: "help" }),
    // Moving and folding.
    down: (_, rows, i) => setActiveIndex(Math.min(i + 1, rows.length - 1)),
    up: (_, __, i) => setActiveIndex(Math.max(i - 1, 0)),
    g: () => setActiveIndex(0),
    G: (_, rows) => setActiveIndex(rows.length - 1),
    space: (row) => row && toggleFold(row.project.id),
    left: (row) => row && setCollapsedFor(row.project.id, true),
    right: (row) => row && setCollapsedFor(row.project.id, false),
    // Enter on a project header folds it; on a worktree it opens its terminal.
    return: (row) => {
      if (row?.kind === "project") toggleFold(row.project.id);
      else if (row?.kind === "worktree" && !row.worktree.missing) openWorktreeTerminal(row.project.id, row.worktree.id);
    },
  };
  sidebarKeys.j = sidebarKeys.down!;
  sidebarKeys.k = sidebarKeys.up!;
  sidebarKeys.h = sidebarKeys.left!;
  sidebarKeys.l = sidebarKeys.right!;

  useKeyboard((key) => {
    const top = overlays.topRef.current;
    // Help is read-only: esc / ? / q close it.
    if (top?.kind === "help") {
      if (key.name === "escape" || key.name === "?" || key.name === "q") overlays.close("help");
      return;
    }
    // Any other pop-up owns the keyboard; so does a focused terminal (its own
    // keys, Ctrl+g back, the ⌥ chords — see TerminalPane).
    if (top || focusModeRef.current === "terminal") return;
    const rows = buildRows(projectsRef.current, collapsedRef.current);
    const i = activeIndexRef.current;
    const action = keyIds(key)
      .map((id) => sidebarKeys[id])
      .find(Boolean);
    action?.(rows[i], rows, i);
  });

  // ── Layout ──

  const rows = buildRows(viewProjects, collapsed);
  const active = rows[Math.min(activeIndex, rows.length - 1)];
  const activeKey = active ? rowKey(active) : "";

  // Resolve every mounted worktree that still exists on disk. Their terminals
  // all stay rendered; only the `open` one is visible (see `opened`).
  const activeTermKey = open ? `${open.repoId}:${open.worktreeId}` : null;
  const mounted = opened
    .map((o) => {
      const project = viewProjects.find((p) => p.id === o.repoId);
      const worktree = project?.worktrees.find((w) => w.id === o.worktreeId && !w.missing);
      return project && worktree ? { key: `${o.repoId}:${o.worktreeId}`, repoId: o.repoId, worktree } : null;
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  // Show the placeholder pane only when no mounted terminal is the visible one.
  const showMain = !mounted.some((m) => m.key === activeTermKey);

  // The PR panel follows the worktree on screen: the open terminal's, or the
  // selected row's when no terminal is showing.
  const onScreen =
    mounted.find((m) => m.key === activeTermKey) ??
    (active?.kind === "worktree" ? { repoId: active.project.id, worktree: active.worktree } : null);
  const currentPr = onScreen?.worktree.pr ? { repo: onScreen.repoId, pr: onScreen.worktree.pr } : null;
  currentPrRef.current = currentPr;
  const layout = fitPanels(
    screenWidth,
    prefs.sidebar.width,
    prefs.prPanel.width,
    !prefs.prPanel.hidden && !!currentPr,
    prefs.sidebar.hidden,
  );
  layoutRef.current = layout;

  const overlayActions: OverlayActions = {
    state,
    themeName: theme.name,
    onApplied,
    closeWorktree: (target) => void closeWorktree(target),
    forget: (target) => void forget(target),
    setTracking,
    saveLabel,
    merged: (method) => prefs.saveUi({ mergeMethod: method }),
  };

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.bg}>
      {!prefs.sidebar.hidden && (
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
          onHelp={() => overlays.open({ kind: "help" })}
          width={layout.sidebar}
          onResize={prefs.sidebar.resize}
          onResizeEnd={prefs.sidebar.persistWidth}
          onResetWidth={prefs.sidebar.resetWidth}
          onHide={hideSidebar}
          onJump={jumpToNext}
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
              onTogglePrPanel={prefs.prPanel.toggle}
              diffViewer={prefs.diffViewer}
              onDiffViewer={prefs.chooseDiffViewer}
              onJumpNext={jumpToNext}
            />
          );
        })}
        {showMain && <MainPane row={active} sidebarHidden={prefs.sidebar.hidden} />}
      </box>
      {layout.panel > 0 && currentPr && (
        <PrPanel
          repo={currentPr.repo}
          pr={currentPr.pr}
          width={layout.panel}
          onResize={prefs.prPanel.resize}
          onResizeEnd={prefs.prPanel.persistWidth}
          onResetWidth={prefs.prPanel.resetWidth}
          onClose={prefs.prPanel.toggle}
          onMerge={requestMerge}
          collapsed={prefs.prPanel.collapsed}
          onToggleSection={prefs.prPanel.toggleSection}
          handleRef={prPanelRef}
        />
      )}
      <OverlayLayer overlays={overlays} actions={overlayActions} />
    </box>
  );
}
