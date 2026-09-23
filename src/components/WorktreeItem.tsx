import { TextAttributes, type MouseEvent } from "@opentui/core";
import { useTheme, type Theme } from "../theme";
import { displayName, type Worktree } from "../data/model";
import { checkLook } from "./PrPanel";

interface WorktreeItemProps {
  worktree: Worktree;
  active: boolean;
  onClick?: (event: MouseEvent) => void;
}

/** How each agent status looks: a glyph for the row's first column, plus a label when it's worth your attention. */
export function agentLook(
  agent: Worktree["agent"],
  theme: Theme,
): { glyph: string; color: string; label?: string } {
  switch (agent) {
    case "needs-action":
      return { glyph: "◆", color: theme.agentWaiting, label: "needs action" };
    case "working":
      return { glyph: "◐", color: theme.agentWorking, label: "working" };
    case "done":
      return { glyph: "✓", color: theme.added, label: "done" };
    case "idle":
      return { glyph: "○", color: theme.fgMuted };
    default:
      return { glyph: "·", color: theme.fgFaint };
  }
}

export function WorktreeItem({ worktree, active, onClick }: WorktreeItemProps) {
  const theme = useTheme();
  const look = agentLook(worktree.agent, theme);
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
        {/* Line 1: agent status + name .......... PR, agent label */}
        <box flexDirection="row" alignItems="center">
          <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
            <text fg={look.color} flexShrink={0}>
              {look.glyph}
            </text>
            <text
              fg={theme.fg}
              attributes={active ? TextAttributes.BOLD : undefined}
              flexShrink={1}
              wrapMode="none"
              truncate
            >
              {" " + displayName(worktree)}
            </text>
          </box>

          {/* Open PR, coloured by its checks (red failing, yellow running). */}
          {worktree.pr && (
            <text
              fg={
                worktree.pr.checks
                  ? checkLook(worktree.pr.checks, theme).color
                  : worktree.pr.draft
                    ? theme.fgMuted
                    : theme.added
              }
              flexShrink={0}
            >
              {` ⇡#${worktree.pr.number}${worktree.pr.draft ? "◌" : ""}`}
            </text>
          )}

          {look.label && (
            <text fg={look.color} flexShrink={0}>
              {" " + look.label}
            </text>
          )}
        </box>

        {/* Line 2: branch .......... ●changed-files +added −removed ↑ahead ↓behind */}
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

          {(worktree.changed > 0 || hasStats || hasSync) && (
            <text flexShrink={0}>
              {/* Uncommitted changes: how many files (untracked included). */}
              {worktree.changed > 0 && (
                <span fg={theme.dirty}>{" ●" + worktree.changed}</span>
              )}
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
