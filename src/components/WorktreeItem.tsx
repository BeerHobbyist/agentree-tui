import { TextAttributes, type MouseEvent } from "@opentui/core";
import { animationsOn, PULSE, SPINNER, useTick } from "../anim";
import { mix, useTheme, type Theme } from "../theme";
import { displayName, type Worktree } from "../data/model";
import { ICON } from "../icons";
import { checkLook } from "./PrPanel";

interface WorktreeItemProps {
  worktree: Worktree;
  active: boolean;
  /** The card's renderable id — the sidebar scrolls the selected one into view. */
  id?: string;
  onClick?: (event: MouseEvent) => void;
}

/** How each agent status looks: a glyph for the row's first column, plus a label when it's worth your attention. */
export function agentLook(agent: Worktree["agent"], theme: Theme): { glyph: string; color: string; label?: string } {
  switch (agent) {
    case "needs-action":
      return { glyph: ICON.needsAction, color: theme.agentWaiting, label: "needs action" };
    case "working":
      return { glyph: ICON.working, color: theme.agentWorking, label: "working" };
    case "done":
      return { glyph: ICON.done, color: theme.added, label: "done" };
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
 * A worktree as a card in a rounded border: status, name and PR on the first
 * line; the branch and its changes on the second; what the agent is doing set
 * into the bottom edge. Selecting it only recolours it — the border, padding
 * and text are the same either way, so nothing moves when it's clicked.
 */
export function WorktreeItem({ worktree, active, id, onClick }: WorktreeItemProps) {
  const theme = useTheme();
  const look = agentLook(worktree.agent, theme);
  const hasStats = worktree.added > 0 || worktree.removed > 0;
  const hasSync = worktree.ahead > 0 || worktree.behind > 0;

  return (
    <box
      id={id}
      flexDirection="column"
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={active ? theme.accent : theme.border}
      bottomTitle={look.label && ` ${look.label} `}
      bottomTitleAlignment="right"
      titleColor={look.color}
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={onClick}
    >
      {/* Line 1: status + name .......... PR */}
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

        {/* Its PR: open, coloured by its checks (red failing, yellow running); or merged. */}
        {worktree.pr && (
          <text
            fg={
              worktree.pr.merged
                ? theme.agentWaiting
                : worktree.pr.checks
                  ? checkLook(worktree.pr.checks, theme).color
                  : worktree.pr.draft
                    ? theme.fgMuted
                    : theme.added
            }
            flexShrink={0}
          >
            {worktree.pr.merged
              ? ` ${ICON.merged} #${worktree.pr.number} merged`
              : ` ${worktree.pr.draft ? ICON.prDraft : ICON.pr} #${worktree.pr.number}`}
          </text>
        )}
      </box>

      {/* Line 2: branch (an SSH directory: its path) .......... changed files, +added −removed, ahead, behind */}
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
          {worktree.subtitle ?? worktree.branch}
        </text>

        {(worktree.changed > 0 || hasStats || hasSync) && (
          <text flexShrink={0}>
            {/* Uncommitted changes: how many files (untracked included). */}
            {worktree.changed > 0 && <span fg={theme.dirty}>{` ${ICON.changed}${worktree.changed}`}</span>}
            {hasStats && <span fg={theme.added}>{" +" + worktree.added}</span>}
            {hasStats && <span fg={theme.removed}>{" −" + worktree.removed}</span>}
            {hasSync && worktree.ahead > 0 && <span fg={theme.ahead}>{` ${ICON.ahead}${worktree.ahead}`}</span>}
            {hasSync && worktree.behind > 0 && <span fg={theme.behind}>{` ${ICON.behind}${worktree.behind}`}</span>}
          </text>
        )}
      </box>
    </box>
  );
}
