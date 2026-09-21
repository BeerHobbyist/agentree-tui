import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { theme } from "./theme";
import type { Project, Worktree } from "./data/model";
import { status as gitStatus } from "./services/git";
import { Sidebar, projectKey, worktreeKey } from "./components/Sidebar";
import {
  AddWorktreeModal,
  type PreselectRepo,
  type Selection,
} from "./components/AddWorktreeModal";
import { loadState, reconcile, type State } from "./store";
import { TerminalPane } from "./components/TerminalPane";

function MainPane({ row }: { row: Row | undefined }) {
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

type Row =
  | { kind: "project"; project: Project }
  | { kind: "worktree"; project: Project; worktree: Worktree };

/** The visible, navigable rows: every project header, plus the worktrees of expanded projects. */
function buildRows(projects: Project[], collapsed: Set<string>): Row[] {
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

function rowKey(row: Row): string {
  return row.kind === "project"
    ? projectKey(row.project.id)
    : worktreeKey(row.project.id, row.worktree.id);
}

function App({
  initialProjects,
  state,
}: {
  initialProjects: Project[];
  state: State;
}) {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeIndex, setActiveIndex] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [preselect, setPreselect] = useState<PreselectRepo | null>(null);
  // The worktree whose terminal is mounted in the content pane, and where keys go.
  const [open, setOpen] = useState<{ repoId: string; worktreeId: string } | null>(
    null,
  );
  const [focusMode, setFocusMode] = useState<"sidebar" | "terminal">("sidebar");

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

  const setCollapsedFor = (projectId: string, wantCollapsed: boolean) => {
    const next = new Set(collapsedRef.current);
    if (wantCollapsed) next.add(projectId);
    else next.delete(projectId);
    setCollapsed(next);
    // Keep the selection valid: snap to the project header in the new layout.
    const rows = buildRows(projectsRef.current, next);
    const idx = rows.findIndex(
      (r) => r.kind === "project" && r.project.id === projectId,
    );
    if (idx >= 0) setActiveIndex(idx);
  };

  const handleApplied = (newProjects: Project[], sel: Selection) => {
    setProjects(newProjects);
    const nextCollapsed = new Set(collapsedRef.current);
    nextCollapsed.delete(sel.repoId);
    setCollapsed(nextCollapsed);
    const rows = buildRows(newProjects, nextCollapsed);
    const idx = rows.findIndex(
      (r) =>
        r.kind === "worktree" &&
        r.project.id === sel.repoId &&
        r.worktree.id === sel.worktreeId,
    );
    if (idx >= 0) setActiveIndex(idx);
    setModalOpen(false);
    setPreselect(null);
  };

  const openAdd = (pre: PreselectRepo | null) => {
    setPreselect(pre);
    setModalOpen(true);
  };

  /** Open the add-worktree modal with the given project's repo preselected. */
  const openAddForProject = (projectId: string) => {
    const proj = projectsRef.current.find((p) => p.id === projectId);
    if (!proj) return;
    openAdd({ nameWithOwner: proj.id, name: proj.name, root: proj.root });
  };

  /** Open (mount + focus) a worktree's terminal — used by click and Enter. */
  const openWorktreeTerminal = (repoId: string, worktreeId: string) => {
    setOpen({ repoId, worktreeId });
    setFocusMode("terminal");
    const rows = buildRows(projectsRef.current, collapsedRef.current);
    const idx = rows.findIndex(
      (r) =>
        r.kind === "worktree" &&
        r.project.id === repoId &&
        r.worktree.id === worktreeId,
    );
    if (idx >= 0) setActiveIndex(idx);
  };

  /** Click a project header: return focus to the sidebar and toggle its fold. */
  const selectProject = (projectId: string) => {
    setFocusMode("sidebar");
    setCollapsedFor(projectId, !collapsedRef.current.has(projectId));
  };

  useKeyboard((key) => {
    // The modal owns the keyboard while open; App nav stays inert.
    if (modalOpenRef.current) return;

    // While a terminal is focused, keys go to it — the app only listens for the
    // return chord (Ctrl+g) to hand focus back to the sidebar.
    if (focusModeRef.current === "terminal") {
      if (key.ctrl && key.name === "g") setFocusMode("sidebar");
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

    if (key.name === "down" || key.name === "j") {
      setActiveIndex(Math.min(i + 1, rows.length - 1));
    } else if (key.name === "up" || key.name === "k") {
      setActiveIndex(Math.max(i - 1, 0));
    } else if (key.name === "g") {
      setActiveIndex(0);
    } else if (key.name === "G") {
      setActiveIndex(rows.length - 1);
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

  // Resolve the opened worktree (if any) for the content pane.
  const openProject = open
    ? projects.find((p) => p.id === open.repoId)
    : undefined;
  const openWorktree = openProject?.worktrees.find(
    (w) => w.id === open?.worktreeId && !w.missing,
  );

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.bg}>
      <Sidebar
        projects={projects}
        collapsed={collapsed}
        activeKey={activeKey}
        onAddWorktree={openAddForProject}
        onOpenWorktree={openWorktreeTerminal}
        onSelectProject={selectProject}
      />
      {open && openProject && openWorktree ? (
        <TerminalPane
          repoId={open.repoId}
          worktree={openWorktree}
          focused={focusMode === "terminal"}
          onRequestFocus={() => setFocusMode("terminal")}
          onExit={() => setFocusMode("sidebar")}
        />
      ) : (
        <MainPane row={active} />
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
    </box>
  );
}

const state = loadState();
const initialProjects = await reconcile(state);
const renderer = await createCliRenderer({ useMouse: true });
createRoot(renderer).render(
  <App initialProjects={initialProjects} state={state} />,
);
