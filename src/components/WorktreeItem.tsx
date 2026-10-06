import { TextAttributes, type MouseEvent } from "@opentui/core";
import { animationsOn, PULSE, SPINNER, useTick } from "../anim";
import { mix, useTheme, type Theme } from "../theme";
import { displayName, type Worktree } from "../data/model";
import { ICON } from "../icons";
import { prBadge } from "./PrPanel";

interface WorktreeItemProps {
  worktree: Worktree;
  active: boolean;
  /** The row's renderable id — the sidebar scrolls the selected one into view. */
  id?: string;
  onClick?: (event: MouseEvent) => void;
  /** Its size changed — first when it's laid out after mounting. */
  onResize?: () => void;
}

/** How each agent status looks: the glyph in the row's first column, and its colour. */
export function agentLook(agent: Worktree["agent"], theme: Theme): { glyph: string; color: string } {
  switch (agent) {
    case "needs-action":
      return { glyph: ICON.needsAction, color: theme.agentWaiting };
    case "working":
      return { glyph: ICON.working, color: theme.agentWorking };
    case "done":
      return { glyph: ICON.done, color: theme.added };
    case "idle":
      return { glyph: ICON.idle, color: theme.fgMuted };
    default:
      return { glyph: ICON.noAgent, color: theme.fgFaint };
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
 * A worktree as a card in a rounded border: status, name, uncommitted files
 * and its PR; under them the branch, line counts, ahead / behind. Selecting it
 * only recolours the border — every card has both lines — so nothing moves
 * when one is clicked.
 */
export function WorktreeItem({ worktree, active, id, onClick, onResize }: WorktreeItemProps) {
  const theme = useTheme();
  // An SSH directory's subtitle is its path on the host.
  const where = worktree.subtitle ?? worktree.branch;
  const hasStats = worktree.added > 0 || worktree.removed > 0;
  const badge = worktree.pr && prBadge(worktree.pr, theme);

  return (
    <box
      id={id}
      flexDirection="column"
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={active ? theme.accent : theme.border}
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={onClick}
      onSizeChange={onResize}
    >
      {/* status + name .......... changed files, PR */}
      <box flexDirection="row" alignItems="center">
        <AgentGlyph agent={worktree.agent} bg={theme.panel} />
        <text
          fg={theme.fg}
          attributes={TextAttributes.BOLD}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          wrapMode="none"
          truncate
        >
          {" " + displayName(worktree)}
        </text>
        {/* Uncommitted changes: how many files (untracked included). */}
        {worktree.changed > 0 && (
          <text fg={theme.dirty} flexShrink={0}>
            {` ${ICON.changed}${worktree.changed}`}
          </text>
        )}
        {badge && (
          <text fg={badge.color} flexShrink={0}>
            {" " + badge.text}
          </text>
        )}
      </box>

      {/* branch (an SSH directory: its path) .......... +added −removed, ahead, behind */}
      <box flexDirection="row" alignItems="center">
        <text fg={theme.fgFaint} flexShrink={0}>
          {(worktree.subtitle ? ICON.folder : ICON.branch) + " "}
        </text>
        <text
          fg={active ? theme.fgMuted : theme.fgFaint}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          wrapMode="none"
          truncate
        >
          {where}
        </text>
        {(hasStats || worktree.ahead > 0 || worktree.behind > 0) && (
          <text flexShrink={0}>
            {hasStats && <span fg={theme.added}>{" +" + worktree.added}</span>}
            {hasStats && <span fg={theme.removed}>{" −" + worktree.removed}</span>}
            {worktree.ahead > 0 && <span fg={theme.ahead}>{` ${ICON.ahead}${worktree.ahead}`}</span>}
            {worktree.behind > 0 && <span fg={theme.behind}>{` ${ICON.behind}${worktree.behind}`}</span>}
          </text>
        )}
      </box>
    </box>
  );
}
