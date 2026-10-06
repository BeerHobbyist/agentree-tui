/**
 * A pop-up in OpenCode's style: a panel with no border over a dimmed screen,
 * its title bold on the left and a ✕ on the right, a quarter of the way
 * down. Every dialog — prompts, pickers, confirms, help — is one of these.
 */
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { type Theme, useTheme } from "../theme";

/** What's behind a dialog shows through, darkened. */
const BACKDROP = "#00000099";

interface DialogProps {
  title: string;
  width?: number;
  /** ✕ in the corner (or esc), or a click outside. Omit while it can't be closed (busy). */
  onClose?: () => void;
  /** The title's colour — a destructive confirm's in red. */
  titleColor?: string;
  /** Rows from the top (default: a quarter of the screen down) — a tall dialog wants more room. */
  top?: number;
  zIndex?: number;
  children: ReactNode;
}

export function Dialog({ title, width = 60, onClose, titleColor, top: topRows, zIndex = 100, children }: DialogProps) {
  const theme = useTheme();
  const { width: cols, height } = useTerminalDimensions();
  const top = topRows ?? Math.max(1, Math.floor(height / 4));
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={zIndex}
      backgroundColor={BACKDROP}
      flexDirection="column"
      alignItems="center"
      onMouseDown={(e) => {
        e.stopPropagation();
        onClose?.();
      }}
    >
      <box
        marginTop={top}
        width={Math.min(width, cols - 4)}
        maxHeight={height - top - 1}
        flexDirection="column"
        backgroundColor={theme.panelAlt}
        paddingTop={1}
        paddingBottom={1}
        // A click inside isn't a click outside.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <box flexDirection="row" flexShrink={0} paddingLeft={3} paddingRight={3}>
          <text
            fg={titleColor ?? theme.fg}
            attributes={TextAttributes.BOLD}
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            wrapMode="none"
            truncate
          >
            {title}
          </text>
          {onClose && (
            <text
              fg={theme.fgMuted}
              flexShrink={0}
              onMouseDown={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              {"✕"}
            </text>
          )}
        </box>
        <box flexDirection="column" flexShrink={1} minHeight={0} paddingLeft={3} paddingRight={3} paddingTop={1}>
          {children}
        </box>
      </box>
    </box>
  );
}

/** Colours for a list row: the selected one filled with the accent, its text dark and bold. */
export function rowLook(theme: Theme, selected: boolean) {
  return selected
    ? { bg: theme.accent, fg: theme.bg, muted: theme.bg, marker: theme.bg, bold: TextAttributes.BOLD }
    : { bg: undefined, fg: theme.fg, muted: theme.fgFaint, marker: theme.fgMuted, bold: undefined };
}
