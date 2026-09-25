import { useEffect, useRef } from "react";
import { MouseButton, TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { useTheme } from "../theme";
import type { Project } from "../data/model";
import { DEFAULT_SIDEBAR_WIDTH } from "../layout";
import { type Hint, Hints } from "./Hints";
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
  /** Hide the sidebar (its footer's ⇤; also `b`). */
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

const COMMANDS: Hint = { key: "^p", text: "commands" };
const NEXT_AGENT: Hint = { key: "Tab", text: "next agent" };

/**
 * The footer's one line of keys: what you can do with the selected row, not a
 * list of everything (that's the command palette, `^p`, always last). An agent
 * needing you comes first.
 */
export function footerHint(projects: Project[], activeKey: string, agentWaiting: boolean): Hint[] {
  if (projects.length === 0) return [{ key: "n", text: "repo" }, { key: "s", text: "host" }, COMMANDS];
  for (const p of projects) {
    if (activeKey === projectKey(p.id)) {
      if (agentWaiting) return [NEXT_AGENT, COMMANDS];
      return p.ssh
        ? [{ key: "a", text: "dir" }, { key: "d", text: "remove" }, COMMANDS]
        : [{ key: "⏎", text: "fold" }, { key: "a", text: "new" }, COMMANDS];
    }
    const w = p.worktrees.find((w) => activeKey === worktreeKey(p.id, w.id));
    if (!w) continue;
    if (agentWaiting) return [NEXT_AGENT, COMMANDS];
    if (p.ssh) return [{ key: "⏎", text: "open" }, { key: "d", text: "remove" }, COMMANDS];
    if (w.id === "main") return [{ key: "⏎", text: "open" }, { key: "a", text: "new" }, COMMANDS];
    if (w.pr?.merged) return [{ key: "d", text: "close (merged)" }, COMMANDS];
    return [{ key: "⏎", text: "open" }, { key: "d", text: "close" }, COMMANDS];
  }
  return agentWaiting ? [NEXT_AGENT, COMMANDS] : [COMMANDS];
}

function ProjectGroup({
  project,
  collapsed,
  activeKey,
  onAddWorktree,
  onClickWorktree,
  onRenameWorktree,
  onSelectProject,
}: {
  project: Project;
  collapsed: boolean;
  activeKey: string;
  onAddWorktree: (projectId: string) => void;
  onClickWorktree: (repoId: string, worktreeId: string) => void;
  onRenameWorktree?: (repoId: string, worktreeId: string) => void;
  onSelectProject: (projectId: string) => void;
}) {
  const theme = useTheme();
  const headerActive = activeKey === projectKey(project.id);
  const dirtyCount = project.worktrees.filter((w) => w.dirty).length;
  const urgent = URGENCY.find((s) => project.worktrees.some((w) => w.agent === s));

  const band = headerActive ? theme.activeBg : theme.panelAlt;

  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      {/* Project header: a band across the sidebar, like the PR panel's sections */}
      <box
        id={rowId(projectKey(project.id))}
        flexDirection="row"
        backgroundColor={band}
        onMouseDown={() => onSelectProject(project.id)}
      >
        {/* accent gutter for the selected header */}
        <box width={1} backgroundColor={headerActive ? theme.accent : band} />
        <box flexDirection="row" alignItems="center" flexGrow={1} paddingLeft={1} paddingRight={1}>
          <text fg={headerActive ? theme.accent : theme.fgMuted} flexShrink={0}>
            {collapsed ? "▸ " : "▾ "}
          </text>
          <text fg={theme.accent} flexShrink={0}>
            {project.ssh ? "⌁ " : "◈ "}
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
          {/* Folded: surface what's inside — an agent needing you first. */}
          {collapsed && urgent && (
            <box flexDirection="row" flexShrink={0} marginRight={1}>
              <AgentGlyph agent={urgent} bg={band} />
            </box>
          )}
          {collapsed && dirtyCount > 0 && (
            <text fg={theme.dirty} flexShrink={0}>
              {"● "}
            </text>
          )}
          <text fg={theme.fgFaint} flexShrink={0}>
            {String(project.worktrees.length)}
          </text>
          {/* Clickable "add worktree" button (also bound to the `a` key). */}
          <text fg={theme.accent} flexShrink={0} onMouseDown={() => onAddWorktree(project.id)}>
            {"  ＋"}
          </text>
        </box>
      </box>

      {/* Project root path (hidden while collapsed to stay compact) */}
      {!collapsed && (
        <box paddingLeft={3} paddingRight={2}>
          <text fg={theme.fgFaint} attributes={TextAttributes.DIM} wrapMode="none" truncate>
            {project.ssh ? `ssh ${project.ssh.host}` : project.root}
          </text>
        </box>
      )}

      {/* Worktrees: cards with a blank line between them */}
      {!collapsed && (
        <box flexDirection="column" flexShrink={0} marginTop={1} marginLeft={1}>
          {project.worktrees.map((wt, i) => (
            <box key={wt.id} flexShrink={0} marginBottom={i < project.worktrees.length - 1 ? 1 : 0}>
              <WorktreeItem
                worktree={wt}
                id={rowId(worktreeKey(project.id, wt.id))}
                active={worktreeKey(project.id, wt.id) === activeKey}
                onClick={(e) => {
                  // Handled here: a double-click hands focus to the terminal,
                  // which the sidebar's own click-to-focus mustn't undo.
                  e.stopPropagation();
                  if (e.button === MouseButton.RIGHT) onRenameWorktree?.(project.id, wt.id);
                  else onClickWorktree(project.id, wt.id);
                }}
              />
            </box>
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
  useEffect(() => {
    listRef.current?.scrollChildIntoView(rowId(activeKey));
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
        {/* Top row (it used to be padding): the hide button, in the corner where
            a collapse control is looked for. */}
        <box flexDirection="row" flexShrink={0} height={1} justifyContent="flex-end" paddingRight={1}>
          {onHide && (
            <text fg={theme.fgMuted} onMouseDown={onHide}>
              {"⇤"}
            </text>
          )}
        </box>
        {/* Project groups */}
        <scrollbox ref={listRef} flexGrow={1} flexShrink={1} minHeight={0} scrollY>
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
              />
            ))
          )}
        </scrollbox>

        {/* Footer / status summary */}
        <box
          flexDirection="column"
          flexShrink={0}
          borderColor={theme.border}
          border={["top"]}
          paddingLeft={2}
          paddingRight={2}
        >
          <box flexDirection="row" alignItems="center">
            {/* Agents across all projects: ◆ needs action · ◐ working · ✓ done. */}
            {agentCounts.length === 0 ? (
              <text fg={theme.fgMuted} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
                {"○ no agent activity"}
              </text>
            ) : (
              // Each count takes you to the next agent in that state (also Tab).
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
            )}
            {/* Clickable footer controls (also keys t / ?). */}
            <text fg={theme.fgMuted} flexShrink={0} onMouseDown={onCycleTheme}>
              {" ◑ " + theme.name + " "}
            </text>
            <text fg={theme.accent} flexShrink={0} onMouseDown={onHelp}>
              {" ? "}
            </text>
          </box>
          <Hints
            hints={footerHint(
              projects,
              activeKey,
              agentCounts.some((c) => c.state !== "working"),
            )}
          />
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
