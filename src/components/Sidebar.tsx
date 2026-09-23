import { useRef } from "react";
import { TextAttributes, type BoxRenderable } from "@opentui/core";
import { useTheme } from "../theme";
import type { Project } from "../data/model";
import { DEFAULT_SIDEBAR_WIDTH } from "../layout";
import { ResizeHandle } from "./ResizeHandle";
import { WorktreeItem } from "./WorktreeItem";

interface SidebarProps {
  projects: Project[];
  /** Set of collapsed project ids. */
  collapsed: Set<string>;
  /** Key of the selected row: `projectId` for a header, `projectId:worktreeId` for a worktree. */
  activeKey: string;
  /** Open the add-worktree flow with this project preselected. */
  onAddWorktree: (projectId: string) => void;
  /** Click a worktree row → open its terminal. */
  onOpenWorktree: (repoId: string, worktreeId: string) => void;
  /** Click a project header → select it + toggle fold. */
  onSelectProject: (projectId: string) => void;
  /** Cycle to the next theme. */
  onCycleTheme: () => void;
  /** Open the help overlay. */
  onHelp: () => void;
  width?: number;
  /** Dragging the right-edge divider: the width it's being dragged to. */
  onResize?: (width: number) => void;
  /** The divider drag ended. */
  onResizeEnd?: () => void;
  /** Double-clicked the divider: back to the default width. */
  onResetWidth?: () => void;
}

export function projectKey(projectId: string): string {
  return projectId;
}

export function worktreeKey(projectId: string, worktreeId: string): string {
  return projectId + ":" + worktreeId;
}

function ProjectGroup({
  project,
  collapsed,
  activeKey,
  onAddWorktree,
  onOpenWorktree,
  onSelectProject,
}: {
  project: Project;
  collapsed: boolean;
  activeKey: string;
  onAddWorktree: (projectId: string) => void;
  onOpenWorktree: (repoId: string, worktreeId: string) => void;
  onSelectProject: (projectId: string) => void;
}) {
  const theme = useTheme();
  const headerActive = activeKey === projectKey(project.id);
  const dirtyCount = project.worktrees.filter((w) => w.dirty).length;

  return (
    <box flexDirection="column" marginBottom={1}>
      {/* Project header */}
      <box
        flexDirection="row"
        backgroundColor={headerActive ? theme.activeBg : theme.panel}
        onMouseDown={() => onSelectProject(project.id)}
      >
        {/* accent gutter for the selected header */}
        <box
          width={1}
          backgroundColor={headerActive ? theme.accent : theme.panel}
        />
        <box flexDirection="row" alignItems="center" flexGrow={1} paddingLeft={1} paddingRight={2}>
          <text fg={headerActive ? theme.accent : theme.fgMuted} flexShrink={0}>
            {collapsed ? "▸ " : "▾ "}
          </text>
          <text fg={theme.accent} flexShrink={0}>
            {"◈ "}
          </text>
          <text
            fg={theme.fg}
            attributes={TextAttributes.BOLD}
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            wrapMode="none"
            truncate
          >
            {project.name}
          </text>
          {collapsed && dirtyCount > 0 && (
            <text fg={theme.dirty} flexShrink={0}>
              {"● "}
            </text>
          )}
          <text fg={theme.fgFaint} flexShrink={0}>
            {String(project.worktrees.length)}
          </text>
          {/* Clickable "add worktree" button (also bound to the `a` key). */}
          <text
            fg={theme.accent}
            flexShrink={0}
            onMouseDown={() => onAddWorktree(project.id)}
          >
            {"  ＋"}
          </text>
        </box>
      </box>

      {/* Project root path (hidden while collapsed to stay compact) */}
      {!collapsed && (
        <box paddingLeft={4} paddingRight={2}>
          <text
            fg={theme.fgFaint}
            attributes={TextAttributes.DIM}
            wrapMode="none"
            truncate
          >
            {project.root}
          </text>
        </box>
      )}

      {/* Worktrees, indented under the project with a vertical guide rule */}
      {!collapsed && (
        <box
          flexDirection="column"
          marginTop={1}
          marginLeft={2}
          paddingLeft={1}
          border={["left"]}
          borderColor={theme.border}
        >
          {project.worktrees.map((wt) => (
            <WorktreeItem
              key={wt.id}
              worktree={wt}
              active={worktreeKey(project.id, wt.id) === activeKey}
              onClick={() => onOpenWorktree(project.id, wt.id)}
            />
          ))}
        </box>
      )}
    </box>
  );
}

export function Sidebar({
  projects,
  collapsed,
  activeKey,
  onAddWorktree,
  onOpenWorktree,
  onSelectProject,
  onCycleTheme,
  onHelp,
  width = DEFAULT_SIDEBAR_WIDTH,
  onResize,
  onResizeEnd,
  onResetWidth,
}: SidebarProps) {
  const theme = useTheme();
  const rootRef = useRef<BoxRenderable>(null);
  const dirtyCount = projects.reduce(
    (n, p) => n + p.worktrees.filter((w) => w.dirty).length,
    0,
  );

  return (
    <box
      ref={rootRef}
      width={width}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={theme.panel}
    >
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        {/* Project groups */}
        <box flexDirection="column" flexGrow={1} paddingTop={1}>
          {projects.length === 0 ? (
            <box flexDirection="column" paddingLeft={2} paddingRight={2}>
              <text fg={theme.fgMuted}>{"No projects yet."}</text>
              <text fg={theme.fgFaint} attributes={TextAttributes.DIM}>
                {"Press n to add one."}
              </text>
            </box>
          ) : (
            projects.map((project) => (
              <ProjectGroup
                key={project.id}
                project={project}
                collapsed={collapsed.has(project.id)}
                activeKey={activeKey}
                onAddWorktree={onAddWorktree}
                onOpenWorktree={onOpenWorktree}
                onSelectProject={onSelectProject}
              />
            ))
          )}
        </box>

        {/* Footer / status summary */}
        <box
          flexDirection="column"
          borderColor={theme.border}
          border={["top"]}
          paddingLeft={2}
          paddingRight={2}
        >
          <box flexDirection="row" alignItems="center">
            <text fg={theme.dirty}>{"●"}</text>
            <text fg={theme.fgMuted} flexGrow={1}>
              {" " + dirtyCount + " dirty"}
            </text>
            {/* Clickable footer controls (also keys t / ?). */}
            <text fg={theme.fgMuted} flexShrink={0} onMouseDown={onCycleTheme}>
              {" ◑ " + theme.name + " "}
            </text>
            <text fg={theme.accent} flexShrink={0} onMouseDown={onHelp}>
              {" ? "}
            </text>
          </box>
          <text fg={theme.fgFaint} attributes={TextAttributes.DIM}>
            {"↑↓ move  ⏎ terminal  a +wt  d close  n new  t theme  ? help  q quit"}
          </text>
        </box>
      </box>
      {/* Right edge: drag to resize (replaces the old right border). The
          dragged-to column becomes the new last column of the sidebar. */}
      <ResizeHandle
        onDrag={(screenX) => onResize?.(screenX - (rootRef.current?.screenX ?? 0) + 1)}
        onDragEnd={() => onResizeEnd?.()}
        onReset={() => onResetWidth?.()}
      />
    </box>
  );
}
