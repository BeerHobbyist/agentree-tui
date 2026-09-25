import { TextAttributes, type MouseEvent } from "@opentui/core";
import { animationsOn, PULSE, SPINNER, useTick } from "../anim";
import { mix, useTheme, type Theme } from "../theme";
import { displayName, type Worktree } from "../data/model";
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

/**
 * A worktree as a two-line card: status, name and PR on the first line; the
 * branch, its changes and what the agent is doing on the second. The sidebar
 * puts a blank line between cards.
 */
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

export function WorktreeItem({ worktree, active, id, onClick }: WorktreeItemProps) {
  const theme = useTheme();
  const look = agentLook(worktree.agent, theme);
  const bg = active ? theme.activeBg : theme.panel;
  const hasStats = worktree.added > 0 || worktree.removed > 0;
  const hasSync = worktree.ahead > 0 || worktree.behind > 0;

  return (
    <box id={id} flexDirection="row" backgroundColor={bg} height={2} onMouseDown={onClick}>
      {/* Accent bar for the selected card */}
      <box width={1} backgroundColor={active ? theme.accent : theme.panel} />

      <box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={1} paddingRight={1}>
        {/* Line 1: status + name .......... PR */}
        <box flexDirection="row" alignItems="center">
          <AgentGlyph agent={worktree.agent} bg={bg} />
          <text
            fg={theme.fg}
            attributes={active ? TextAttributes.BOLD : undefined}
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
                ? ` ⇡#${worktree.pr.number} merged`
                : ` ⇡#${worktree.pr.number}${worktree.pr.draft ? "◌" : ""}`}
            </text>
          )}
        </box>

        {/* Line 2, under the name: branch (an SSH directory: its path) .......... ●changed +added −removed ↑ahead ↓behind, agent */}
        <box flexDirection="row" alignItems="center" paddingLeft={2}>
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
              {worktree.changed > 0 && <span fg={theme.dirty}>{" ●" + worktree.changed}</span>}
              {hasStats && <span fg={theme.added}>{" +" + worktree.added}</span>}
              {hasStats && <span fg={theme.removed}>{" −" + worktree.removed}</span>}
              {hasSync && worktree.ahead > 0 && <span fg={theme.ahead}>{" ↑" + worktree.ahead}</span>}
              {hasSync && worktree.behind > 0 && <span fg={theme.behind}>{" ↓" + worktree.behind}</span>}
            </text>
          )}

          {look.label && (
            <text fg={look.color} flexShrink={0}>
              {"  " + look.label}
            </text>
          )}
        </box>
      </box>
    </box>
  );
}
