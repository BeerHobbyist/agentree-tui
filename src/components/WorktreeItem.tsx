import { TextAttributes, type MouseEvent } from "@opentui/core";
import { animationsOn, PULSE, SPINNER, useTick } from "../anim";
import { mix, useTheme, type Theme } from "../theme";
import { displayName, type Worktree } from "../data/model";
import { prBadge } from "./PrPanel";

interface WorktreeItemProps {
  worktree: Worktree;
  active: boolean;
  /** The row's renderable id — the sidebar scrolls the selected one into view. */
  id?: string;
  onClick?: (event: MouseEvent) => void;
  /** Its height changed — laid out anew, as the selected row opens its second line. */
  onResize?: () => void;
}

/** How each agent status looks: the glyph in the row's first column, and its colour. */
export function agentLook(agent: Worktree["agent"], theme: Theme): { glyph: string; color: string } {
  switch (agent) {
    case "needs-action":
      return { glyph: "◆", color: theme.agentWaiting };
    case "working":
      return { glyph: "◐", color: theme.agentWorking };
    case "done":
      return { glyph: "✓", color: theme.added };
    case "idle":
      return { glyph: "○", color: theme.fgMuted };
    default:
      return { glyph: "·", color: theme.fgFaint };
  }
}

/**
 * An agent's status glyph, alive: a spinner while it works, a slow pulse while
 * it needs you (fading toward `bg`, what it's drawn on). Still otherwise, and
 * with animations off.
 */
export function AgentGlyph({ agent, bg }: { agent: Worktree["agent"]; bg: string }) {
  const theme = useTheme();
  const look = agentLook(agent, theme);
  const animated = (agent === "working" || agent === "needs-action") && animationsOn();
  const tick = useTick(animated);
  const glyph = animated && agent === "working" ? SPINNER[tick % SPINNER.length] : look.glyph;
  const color = animated && agent === "needs-action" ? mix(look.color, bg, PULSE[tick % PULSE.length]!) : look.color;
  return (
    <text fg={color} flexShrink={0}>
      {glyph}
    </text>
  );
}

/**
 * A worktree as one line: status, name, uncommitted files and its PR. The
 * selected one opens a second line with what's only worth reading up close —
 * the branch (when it isn't the name already), line counts, ahead / behind.
 */
export function WorktreeItem({ worktree, active, id, onClick, onResize }: WorktreeItemProps) {
  const theme = useTheme();
  const bg = active ? theme.activeBg : theme.panel;
  const name = displayName(worktree);
  // An SSH directory's subtitle is its path on the host.
  const where = worktree.subtitle ?? worktree.branch;
  const showWhere = where !== name;
  const hasStats = worktree.added > 0 || worktree.removed > 0;
  const hasSync = worktree.ahead > 0 || worktree.behind > 0;
  const details = active && (showWhere || hasStats || hasSync);
  const badge = worktree.pr && prBadge(worktree.pr, theme);

  return (
    <box
      id={id}
      flexDirection="row"
      flexShrink={0}
      backgroundColor={bg}
      height={details ? 2 : 1}
      onMouseDown={onClick}
      onSizeChange={onResize}
    >
      {/* Accent bar for the selected row */}
      <box width={1} backgroundColor={active ? theme.accent : theme.panel} />

      <box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={3} paddingRight={1}>
        {/* status + name .......... ●changed ⇡#PR */}
        <box flexDirection="row" alignItems="center">
          <AgentGlyph agent={worktree.agent} bg={bg} />
          <text
            fg={active ? theme.fg : theme.fgMuted}
            attributes={active ? TextAttributes.BOLD : undefined}
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            wrapMode="none"
            truncate
          >
            {" " + name}
          </text>
          {/* Uncommitted changes: how many files (untracked included). */}
          {worktree.changed > 0 && (
            <text fg={theme.dirty} flexShrink={0}>
              {" ●" + worktree.changed}
            </text>
          )}
          {badge && (
            <text fg={badge.color} flexShrink={0}>
              {" " + badge.text}
            </text>
          )}
        </box>

        {/* Selected: branch (an SSH directory: its path) .......... +added −removed ↑ahead ↓behind */}
        {details && (
          <box flexDirection="row" alignItems="center" paddingLeft={2}>
            <text fg={theme.fgMuted} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
              {showWhere ? where : ""}
            </text>
            {(hasStats || hasSync) && (
              <text flexShrink={0}>
                {hasStats && <span fg={theme.added}>{" +" + worktree.added}</span>}
                {hasStats && <span fg={theme.removed}>{" −" + worktree.removed}</span>}
                {worktree.ahead > 0 && <span fg={theme.ahead}>{" ↑" + worktree.ahead}</span>}
                {worktree.behind > 0 && <span fg={theme.behind}>{" ↓" + worktree.behind}</span>}
              </text>
            )}
          </box>
        )}
      </box>
    </box>
  );
}
