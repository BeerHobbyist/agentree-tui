import { useEffect, useRef } from "react";
import { MouseButton, TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { useTheme } from "../theme";
import type { Project } from "../data/model";
import { DEFAULT_SIDEBAR_WIDTH } from "../layout";
import { ResizeHandle } from "./ResizeHandle";
import { AgentGlyph, WorktreeItem, agentLook } from "./WorktreeItem";
import type { AgentStatus } from "../data/model";

/** Most urgent first — what a folded project shows for its worktrees. */
const URGENCY: AgentStatus[] = ["needs-action", "working", "done"];

interface SidebarProps {
  projects: Project[];
  /** Set of collapsed project ids. */
  collapsed: Set<string>;
  /** Key of the selected row: `projectId` for a header, `projectId:worktreeId` for a worktree. */
  activeKey: string;
  /** Open the add-worktree flow with this project preselected. */
  onAddWorktree: (projectId: string) => void;
  /** Click a worktree row → select it and show its terminal (a double-click also focuses it). */
  onClickWorktree: (repoId: string, worktreeId: string) => void;
  /** Right-click a worktree row → rename it (its label only). */
  onRenameWorktree?: (repoId: string, worktreeId: string) => void;
  /** Any other click on the sidebar → the sidebar takes keyboard focus. */
  onFocus?: () => void;
  /** Click a project header → select it + toggle fold. */
  onSelectProject: (projectId: string) => void;
  /** Cycle to the next theme. */
  onCycleTheme: () => void;
  /** Open the help overlay. */
  onHelp: () => void;
  /** Hide the sidebar (its footer's «; also `b`). */
  onHide?: () => void;
  /** Click a footer count (◆ 2) → go to the next agent in that state. */
  onJump?: (state: AgentStatus) => void;
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

/** A row's renderable id, from its key — for scrolling it into view. */
function rowId(key: string): string {
  return `sidebar-row:${key}`;
}

function ProjectGroup({
  project,
  collapsed,
  activeKey,
  onAddWorktree,
  onClickWorktree,
  onRenameWorktree,
  onSelectProject,
  scrollIntoView,
}: {
  project: Project;
  collapsed: boolean;
  activeKey: string;
  /** Scroll the list to show this row. */
  scrollIntoView: (key: string) => void;
  onAddWorktree: (projectId: string) => void;
  onClickWorktree: (repoId: string, worktreeId: string) => void;
  onRenameWorktree?: (repoId: string, worktreeId: string) => void;
  onSelectProject: (projectId: string) => void;
}) {
  const theme = useTheme();
  const headerActive = activeKey === projectKey(project.id);
  const dirtyCount = project.worktrees.filter((w) => w.dirty).length;
  const urgent = URGENCY.find((s) => project.worktrees.some((w) => w.agent === s));

  const bg = headerActive ? theme.activeBg : theme.panel;

  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      <box
        id={rowId(projectKey(project.id))}
        flexDirection="row"
        backgroundColor={bg}
        onMouseDown={() => onSelectProject(project.id)}
      >
        {/* accent gutter for the selected header */}
        <box width={1} backgroundColor={headerActive ? theme.accent : bg} />
        <box flexDirection="row" alignItems="center" flexGrow={1} paddingLeft={1} paddingRight={1}>
          <text fg={theme.fgFaint} flexShrink={0}>
            {collapsed ? "▸ " : "▾ "}
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
            {(project.ssh ? "⌁ " : "") + project.name}
          </text>
          {/* Folded: surface what's inside — an agent needing you first. */}
          {collapsed && urgent && (
            <box flexDirection="row" flexShrink={0} marginLeft={1}>
              <AgentGlyph agent={urgent} bg={bg} />
            </box>
          )}
          {collapsed && dirtyCount > 0 && (
            <text fg={theme.dirty} flexShrink={0}>
              {" ●"}
            </text>
          )}
          {collapsed && (
            <text fg={theme.fgFaint} flexShrink={0}>
              {" " + String(project.worktrees.length)}
            </text>
          )}
          {/* Clickable "add worktree" button (also bound to the `a` key). */}
          <text fg={theme.fgMuted} flexShrink={0} onMouseDown={() => onAddWorktree(project.id)}>
            {"  +"}
          </text>
        </box>
      </box>

      {/* Worktrees, one line each, under the project's name */}
      {!collapsed && (
        <box flexDirection="column" flexShrink={0}>
          {project.worktrees.map((wt) => {
            const key = worktreeKey(project.id, wt.id);
            const active = key === activeKey;
            return (
              <WorktreeItem
                key={wt.id}
                worktree={wt}
                id={rowId(key)}
                active={active}
                // Selected, it can grow a line: keep all of it in view once that's laid out.
                onResize={active ? () => scrollIntoView(key) : undefined}
                onClick={(e) => {
                  // Handled here: a double-click hands focus to the terminal,
                  // which the sidebar's own click-to-focus mustn't undo.
                  e.stopPropagation();
                  if (e.button === MouseButton.RIGHT) onRenameWorktree?.(project.id, wt.id);
                  else onClickWorktree(project.id, wt.id);
                }}
              />
            );
          })}
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
  onClickWorktree,
  onRenameWorktree,
  onSelectProject,
  onCycleTheme,
  onHelp,
  onHide,
  onJump,
  width = DEFAULT_SIDEBAR_WIDTH,
  onResize,
  onResizeEnd,
  onResetWidth,
  onFocus,
}: SidebarProps) {
  const theme = useTheme();
  const rootRef = useRef<BoxRenderable>(null);
  const listRef = useRef<ScrollBoxRenderable>(null);
  const worktrees = projects.flatMap((p) => p.worktrees);

  // The list scrolls (wheel) when it's taller than the sidebar; the selected
  // row is kept in view as the selection moves.
  const scrollIntoView = (key: string) => listRef.current?.scrollChildIntoView(rowId(key));
  useEffect(() => {
    scrollIntoView(activeKey);
  }, [activeKey]);
  const agentCounts = URGENCY.map((state) => ({
    state,
    look: agentLook(state, theme),
    count: worktrees.filter((w) => w.agent === state).length,
  })).filter((c) => c.count > 0);

  return (
    <box
      ref={rootRef}
      width={width}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={theme.panel}
      // Focus follows the click: anywhere on the sidebar gives it the keyboard.
      onMouseDown={() => onFocus?.()}
    >
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        {/* Project groups */}
        <scrollbox ref={listRef} flexGrow={1} flexShrink={1} minHeight={0} scrollY paddingTop={1}>
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
                onClickWorktree={onClickWorktree}
                onRenameWorktree={onRenameWorktree}
                onSelectProject={onSelectProject}
                scrollIntoView={scrollIntoView}
              />
            ))
          )}
        </scrollbox>

        {/* Footer: agents across all projects (◆ needs you · ◐ working · ✓ done),
            then the theme, help and hide buttons (also t / ? / b). */}
        <box
          flexDirection="row"
          alignItems="center"
          flexShrink={0}
          borderColor={theme.border}
          border={["top"]}
          paddingLeft={2}
          paddingRight={1}
        >
          {/* Each count takes you to the next agent in that state (also Tab). */}
          <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
            {agentCounts.map((c, i) => (
              <box
                key={c.state}
                flexDirection="row"
                flexShrink={0}
                marginLeft={i > 0 ? 2 : 0}
                onMouseDown={() => onJump?.(c.state)}
              >
                <AgentGlyph agent={c.state} bg={theme.panel} />
                <text fg={c.look.color}>{` ${c.count}`}</text>
              </box>
            ))}
          </box>
          <text fg={theme.fgMuted} flexShrink={0} onMouseDown={onCycleTheme}>
            {" ◑ "}
          </text>
          <text fg={theme.fgMuted} flexShrink={0} onMouseDown={onHelp}>
            {" ? "}
          </text>
          {onHide && (
            <text fg={theme.fgMuted} flexShrink={0} onMouseDown={onHide}>
              {" « "}
            </text>
          )}
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
