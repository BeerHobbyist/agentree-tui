import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { existsSync } from "node:fs";
import { useEffect, useRef, useState } from "react";
import { useTheme, cycleTheme } from "./theme";
import type { Project, Worktree } from "./data/model";
import { removeWorktree, status as gitStatus } from "./services/git";
import { killSession, sessionName as tmuxSessionName } from "./services/tmux";
import { prForBranch } from "./services/gh";
import { Sidebar, projectKey, worktreeKey } from "./components/Sidebar";
import {
  AddWorktreeModal,
  type PreselectRepo,
  type Selection,
} from "./components/AddWorktreeModal";
import { reconcile, removeManagedWorktree, type State } from "./store";
import { TerminalPane } from "./components/TerminalPane";
import { HelpOverlay } from "./components/HelpOverlay";
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

  // Background pass: fill real git status for on-disk worktrees, non-blocking.
  // Keyed on the set of paths so status updates don't retrigger the effect.
  const pathSig = projects
    .flatMap((p) => p.worktrees.filter((w) => !w.missing).map((w) => w.path))
    .join("|");
  useEffect(() => {
    let cancelled = false;
    const targets = projectsRef.current.flatMap((p) =>
      p.worktrees
        .filter((w) => !w.missing)
        .map((w) => ({ repoId: p.id, id: w.id, path: w.path })),
    );
    (async () => {
      const limit = 4;
      for (let i = 0; i < targets.length; i += limit) {
        const batch = targets.slice(i, i + limit);
        const results = await Promise.all(
          batch.map(async (t) => ({
            t,
            st: await gitStatus(t.path).catch(() => null),
          })),
        );
        if (cancelled) return;
        setProjects((prev) =>
          prev.map((p) => ({
            ...p,
            worktrees: p.worktrees.map((w) => {
              const hit = results.find(
                (r) => r.st && r.t.repoId === p.id && r.t.id === w.id,
              );
              return hit && hit.st ? { ...w, ...hit.st } : w;
            }),
          })),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathSig]);

  // Background pass: look up open PRs for each worktree's branch (cached in gh.ts).
  const prSig = projects
    .flatMap((p) =>
      p.worktrees
        .filter((w) => !w.missing && w.branch && w.branch !== "(detached)")
        .map((w) => `${p.id}:${w.id}:${w.branch}`),
    )
    .join("|");
  useEffect(() => {
    let cancelled = false;
    const targets = projectsRef.current.flatMap((p) =>
      p.worktrees
        .filter((w) => !w.missing && w.branch && w.branch !== "(detached)")
        .map((w) => ({ repoId: p.id, id: w.id, branch: w.branch })),
    );
    (async () => {
      const limit = 4;
      for (let i = 0; i < targets.length; i += limit) {
        const batch = targets.slice(i, i + limit);
        const results = await Promise.all(
          batch.map(async (t) => ({
            t,
            pr: await prForBranch(t.repoId, t.branch).catch(() => null),
          })),
        );
        if (cancelled) return;
        setProjects((prev) =>
          prev.map((p) => ({
            ...p,
            worktrees: p.worktrees.map((w) => {
              const hit = results.find(
                (r) => r.t.repoId === p.id && r.t.id === w.id,
              );
              return hit ? { ...w, pr: hit.pr ?? undefined } : w;
            }),
          })),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prSig]);

  // A burst of keystrokes (key repeat, a paste) arrives in one tick, before
  // React re-renders and refreshes the mirrors above, so every write also
  // updates the mirror — otherwise holding `j` advances a single row.
  const applyActiveIndex = (idx: number) => {
    activeIndexRef.current = idx;
    setActiveIndex(idx);
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

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.bg}>
      <Sidebar
        projects={projects}
        collapsed={collapsed}
        activeKey={activeKey}
        onAddWorktree={openAddForProject}
        onOpenWorktree={openWorktreeTerminal}
        onSelectProject={selectProject}
        onCycleTheme={() => cycleTheme()}
        onHelp={() => setHelpOpen(true)}
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
            />
          );
        })}
        {showMain && <MainPane row={active} />}
      </box>
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
