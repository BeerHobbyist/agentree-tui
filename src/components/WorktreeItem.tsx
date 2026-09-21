import { TextAttributes } from "@opentui/core";
import { useTheme, type Theme } from "../theme";
import type { Worktree } from "../data/model";

interface WorktreeItemProps {
  worktree: Worktree;
  active: boolean;
  onClick?: () => void;
}

function agentBadge(agent: Worktree["agent"], theme: Theme) {
  switch (agent) {
    case "working":
      return { label: "working", color: theme.agentWorking, glyph: "◐" };
    case "waiting":
      return { label: "waiting", color: theme.agentWaiting, glyph: "◆" };
    default:
      return null;
  }
}

export function WorktreeItem({ worktree, active, onClick }: WorktreeItemProps) {
  const theme = useTheme();
  const badge = agentBadge(worktree.agent, theme);
  const dotColor = worktree.dirty ? theme.dirty : theme.clean;
  const hasStats = worktree.added > 0 || worktree.removed > 0;
  const hasSync = worktree.ahead > 0 || worktree.behind > 0;

  return (
    <box
      flexDirection="row"
      backgroundColor={active ? theme.activeBg : theme.panel}
      height={2}
      onMouseDown={onClick}
    >
      {/* Accent bar for the active row */}
      <box width={1} backgroundColor={active ? theme.accent : theme.panel} />

      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
        {/* Line 1: status dot + name .......... agent badge */}
        <box flexDirection="row" alignItems="center">
          <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
            <text fg={dotColor} flexShrink={0}>
              {worktree.dirty ? "●" : "○"}
            </text>
            <text
              fg={theme.fg}
              attributes={active ? TextAttributes.BOLD : undefined}
              flexShrink={1}
              wrapMode="none"
              truncate
            >
              {" " + worktree.name}
            </text>
          </box>

          {badge && (
            <text fg={badge.color} flexShrink={0}>
              {" " + badge.glyph + " " + badge.label}
            </text>
          )}
        </box>

        {/* Line 2: branch .......... +added −removed ↑ahead ↓behind */}
        <box flexDirection="row" alignItems="center">
          <text
            fg={theme.fgFaint}
            attributes={TextAttributes.DIM}
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            wrapMode="none"
            truncate
          >
            {worktree.branch}
          </text>

          {(hasStats || hasSync) && (
            <text flexShrink={0}>
              {hasStats && <span fg={theme.added}>{" +" + worktree.added}</span>}
              {hasStats && (
                <span fg={theme.removed}>{" −" + worktree.removed}</span>
              )}
              {hasSync && worktree.ahead > 0 && (
                <span fg={theme.ahead}>{"  ↑" + worktree.ahead}</span>
              )}
              {hasSync && worktree.behind > 0 && (
                <span fg={theme.behind}>{" ↓" + worktree.behind}</span>
              )}
            </text>
          )}
        </box>
      </box>
    </box>
  );
}
