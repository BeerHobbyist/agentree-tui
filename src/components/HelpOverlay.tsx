import { useRef } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "../theme";

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
      ["?", "toggle this help"],
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
      ["⌥ d", "open a diff in a new tab (v there: viewer)"],
      ["⌥ p", "show / hide the PR panel"],
      ["⌥ w", "close pane"],
      ["⌥ W", "close tab (whole window)"],
      ["⌥ \\  /  ⌥ -", "split horizontal / vertical"],
      ["Ctrl+C", "→ sent to the shell"],
      ["Ctrl+b …", "native tmux keys still work"],
    ],
  },
  {
    title: "Agent status",
    rows: [
      ["◆  needs action", "waiting on you: approve or answer"],
      ["◐  working", "busy with your prompt"],
      ["✓  done", "finished; clears once you look"],
      ["○  idle", "running, nothing to do"],
      ["●3", "3 files with uncommitted changes"],
      ["", "for agents agentree starts (⏎, ⌥a)"],
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
      ["click ＋", "add worktree"],
      ["drag sidebar edge", "resize · double-click to reset"],
      ["click ⇤ / ‹", "hide the sidebar / back to it"],
      ["click ◆ 2 / ✓ 1", "next agent in that state"],
      ["⇡#N in the tab bar", "show / hide the PR panel"],
      ["PR panel", "click a check → its log · a comment → GitHub"],
      ["＋ menu", "new shell · new agent · new diff (hunk)"],
      ["tab bar", "click tab · × close tab · ⬌ ⬍ split · ✕ pane · ‹ back"],
      ["click a pane", "focus that split pane"],
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
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={200}
      alignItems="center"
      justifyContent="center"
      shouldFill={false}
      onMouseDown={onClose}
    >
      <box
        width={66}
        maxHeight="90%"
        borderStyle="rounded"
        border
        borderColor={theme.accent}
        backgroundColor={theme.panel}
        title=" Keyboard & mouse "
        titleAlignment="center"
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        <scrollbox
          ref={scrollRef}
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          scrollY
          contentOptions={{ paddingRight: 1 }}
        >
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
                  <text
                    fg={theme.fgMuted}
                    flexGrow={1}
                    flexShrink={1}
                    minWidth={0}
                    wrapMode="none"
                    truncate
                  >
                    {desc}
                  </text>
                </box>
              ))}
            </box>
          ))}
        </scrollbox>
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM} flexShrink={0}>
          {`theme: ${themeName}  ·  ↑↓ scroll  ·  esc / ? / click to close`}
        </text>
      </box>
    </box>
  );
}
