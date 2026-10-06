import { useRef } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { ICON } from "../icons";
import { useTheme } from "../theme";
import { Dialog } from "./Dialog";
import { Hints, hintsFrom } from "./Hints";

interface HelpOverlayProps {
  themeName: string;
  onClose: () => void;
}

const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Sidebar",
    rows: [
      ["↑ ↓  /  j k", "move selection"],
      ["g  /  G", "first / last"],
      ["␣  /  h  l", "fold / unfold project"],
      ["⏎", "open worktree terminal · fold project"],
      ["a", "add worktree to selected project"],
      ["R", "rename worktree (its label here only)"],
      ["d", "close worktree (deletes it from disk)"],
      ["d  on a project header", "remove project (its files stay on disk)"],
      ["n", "add a project (pick a GitHub repo)"],
      ["s", "add an SSH host (terminals on that machine)"],
      ["t", "cycle theme"],
      ["Tab", "next agent that needs you (then: done)"],
      ["H", "track every claude you start (asks first)"],
      ["p  /  o  /  r", "PR panel · open PR · refresh"],
      ["m", "merge the PR (pick a method, then confirm)"],
      ["PgUp  /  PgDn", "scroll the PR panel"],
      ["[  /  ]", "narrower / wider sidebar"],
      ["b", "hide / show the sidebar"],
      ["=", "reset sidebar width"],
      ["Ctrl+P", "command palette: every action, searchable"],
      ["esc", "dismiss a toast"],
      ["?", "toggle this help (every key is here)"],
      ["q  /  Ctrl+C", "quit"],
    ],
  },
  {
    title: "Terminal (focused)",
    rows: [
      ["Ctrl+G", "back to sidebar (shows it if hidden)"],
      ["⌥ h j k l  /  ⌥ ← ↓ ↑ →", "move between split panes"],
      ["⌥ ,  /  ⌥ .", "previous / next tab"],
      ["⌥ 1–9", "jump to tab"],
      ["⌥ t", "new tab"],
      ["⌥ r", "rename tab"],
      ["⌥ n", "next agent that needs you"],
      ["⌥ a", "open agent in a new tab"],
      ["⌥ d", "open a diff in a new tab — changes, a ref, or picked commits (v there: viewer)"],
      ["⌥ p", "show / hide the PR panel"],
      ["⌥ w", "close pane"],
      ["⌥ W", "close tab (whole window)"],
      ["⌥ \\  /  ⌥ -", "split horizontal / vertical"],
      ["Ctrl+C", "→ sent to the shell"],
      ["Ctrl+b …", "native tmux keys still work"],
      ["agentree --help", "the CLI agents use to drive these tabs"],
    ],
  },
  {
    title: "Icons",
    rows: [
      [ICON.needsAction, "agent needs you: approve or answer (it pulses)"],
      [ICON.working, "agent working on your prompt (it spins)"],
      [ICON.done, "agent done; clears once you look"],
      [ICON.idle, "agent idle: running, nothing to do"],
      ["", "for agents agentree starts (⏎, ⌥a)"],
      [`${ICON.changed}3`, "3 files with uncommitted changes"],
      [`+12 −3  ${ICON.ahead}1 ${ICON.behind}2`, "lines changed · commits ahead / behind"],
      [`${ICON.pr} #42`, "its open PR — green, yellow, red: its checks"],
      [`${ICON.prDraft} #42`, "…a draft"],
      [`${ICON.merged} #42`, "its PR is merged: d closes the worktree"],
      [ICON.host, "a project on an SSH host"],
    ],
  },
  {
    title: "Mouse",
    rows: [
      ["click worktree", "show its terminal (keys stay here)"],
      ["double-click worktree", "…and type in it"],
      ["right-click worktree", "rename it (label only)"],
      ["right-click tab", "rename it"],
      ["click the sidebar", "keys go to the sidebar"],
      ["click project header", "select + fold"],
      [`${ICON.add} on a project`, "add worktree"],
      ["drag sidebar edge", "resize · double-click to reset"],
      [`click ${ICON.hide} / ‹`, "hide the sidebar / back to it"],
      [`click ${ICON.theme} / ${ICON.help}`, "next theme / this help"],
      [`click ${ICON.needsAction} 2 / ${ICON.done} 1`, "next agent in that state"],
      [`${ICON.pr} #N in the tab bar`, "show / hide the PR panel"],
      ["PR panel", "click a check → its log · a comment → GitHub"],
      ["+ in the tab bar", "new shell · new agent · new diff (hunk)"],
      ["tab bar", "× close tab · ◫ ⊟ split · ✕ close pane"],
      ["click a pane", "focus that split pane"],
      ["drag in a shell", "select + copy · click or type to clear"],
    ],
  },
];

export function HelpOverlay({ themeName, onClose }: HelpOverlayProps) {
  const theme = useTheme();
  // The sections scroll when the screen is too short for them all; the app's
  // own help handler closes on esc / ? / q and ignores the rest.
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  useKeyboard((key) => {
    const box = scrollRef.current;
    if (!box) return;
    const page = Math.max(1, box.viewport.height - 1);
    const n = key.name;
    if (n === "down" || n === "j") box.scrollBy(1);
    else if (n === "up" || n === "k") box.scrollBy(-1);
    else if (n === "pagedown" || n === "space") box.scrollBy(page);
    else if (n === "pageup") box.scrollBy(-page);
    else if (n === "g" && !key.shift) box.scrollTo(0);
    else if (n === "g" && key.shift) box.scrollTo(box.scrollHeight);
  });
  return (
    <Dialog title="Keyboard & mouse" width={70} onClose={onClose} top={2} zIndex={200}>
      <scrollbox ref={scrollRef} flexGrow={1} flexShrink={1} minHeight={0} scrollY contentOptions={{ paddingRight: 1 }}>
        {SECTIONS.map((section) => (
          <box key={section.title} flexDirection="column" flexShrink={0} marginBottom={1}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              {section.title}
            </text>
            {section.rows.map(([keys, desc], i) => (
              <box key={String(i)} flexDirection="row" alignItems="center" flexShrink={0}>
                <text fg={theme.fg} flexShrink={0}>
                  {keys.padEnd(24)}
                </text>
                <text fg={theme.fgMuted} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
                  {desc}
                </text>
              </box>
            ))}
          </box>
        ))}
      </scrollbox>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.fgMuted} flexShrink={0}>{`theme ${themeName} · `}</text>
        <Hints hints={hintsFrom("↑↓ scroll · esc / ? close")} />
      </box>
    </Dialog>
  );
}
