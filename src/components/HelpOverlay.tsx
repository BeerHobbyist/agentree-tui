import { TextAttributes } from "@opentui/core";
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
      ["n", "add a project (pick a GitHub repo)"],
      ["t", "cycle theme"],
      ["?", "toggle this help"],
      ["q  /  Ctrl+C", "quit"],
    ],
  },
  {
    title: "Terminal (focused)",
    rows: [
      ["Ctrl+G", "back to sidebar"],
      ["⌥ h j k l  /  ⌥ ← ↓ ↑ →", "move between split panes"],
      ["⌥ ,  /  ⌥ .", "previous / next tab"],
      ["⌥ 1–9", "jump to tab"],
      ["⌥ t", "new tab"],
      ["⌥ a", "open agent in a new tab"],
      ["⌥ d", "open diff (hunk) in a new tab"],
      ["⌥ w", "close pane"],
      ["⌥ W", "close tab (whole window)"],
      ["⌥ \\  /  ⌥ -", "split horizontal / vertical"],
      ["Ctrl+C", "→ sent to the shell"],
      ["Ctrl+b …", "native tmux keys still work"],
    ],
  },
  {
    title: "Mouse",
    rows: [
      ["click worktree", "open its terminal"],
      ["click project header", "select + fold"],
      ["click ＋", "add worktree"],
      ["＋ menu", "new shell · new agent · new diff (hunk)"],
      ["tab bar", "click tab · × close tab · ⬌ ⬍ split · ✕ pane · ‹ back"],
      ["click a pane", "focus that split pane"],
    ],
  },
];

export function HelpOverlay({ themeName, onClose }: HelpOverlayProps) {
  const theme = useTheme();
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
        width={64}
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
        {SECTIONS.map((section) => (
          <box key={section.title} flexDirection="column" marginBottom={1}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              {section.title}
            </text>
            {section.rows.map(([keys, desc], i) => (
              <box key={String(i)} flexDirection="row" alignItems="center">
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
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM}>
          {`theme: ${themeName}   ·   esc / ? / click to close`}
        </text>
      </box>
    </box>
  );
}
