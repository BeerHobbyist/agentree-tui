/**
 * A pop-up over a dimmed screen, in a rounded border like the sidebar's
 * cards: its icon and title on the left and a close button on the right, a
 * quarter of the way down. Every dialog — prompts, pickers, confirms, help — is one of
 * these.
 */
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { ICON } from "../icons";
import { type Theme, useTheme } from "../theme";

/** What's behind a dialog shows through, darkened. */
const BACKDROP = "#00000099";

interface DialogProps {
  title: string;
  /** Drawn before the title, in the accent colour (or the title's). */
  icon?: string;
  width?: number;
  /** Its close button (or esc), or a click outside. Omit while it can't be closed (busy). */
  onClose?: () => void;
  /** The title's colour — a destructive confirm's in red. */
  titleColor?: string;
  /** Rows from the top (default: a quarter of the screen down) — a tall dialog wants more room. */
  top?: number;
  zIndex?: number;
  children: ReactNode;
}

export function Dialog({
  title,
  icon,
  width = 60,
  onClose,
  titleColor,
  top: topRows,
  zIndex = 100,
  children,
}: DialogProps) {
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
        border
        borderStyle="rounded"
        borderColor={theme.border}
        // A click inside isn't a click outside.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2}>
          {icon && (
            <text fg={titleColor ?? theme.accent} flexShrink={0}>
              {icon + " "}
            </text>
          )}
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
              {ICON.close}
            </text>
          )}
        </box>
        <box flexDirection="column" flexShrink={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          {children}
        </box>
      </box>
    </box>
  );
}

/**
 * How a list row looks: the selected one filled with the accent, its text and
 * icon dark and bold, a pointer in its first three columns (blank on the
 * others).
 */
export function rowLook(theme: Theme, selected: boolean) {
  return selected
    ? {
        bg: theme.accent,
        fg: theme.bg,
        muted: theme.bg,
        marker: theme.bg,
        icon: theme.bg,
        bold: TextAttributes.BOLD,
        pointer: ` ${ICON.pointer} `,
      }
    : {
        bg: undefined,
        fg: theme.fg,
        muted: theme.fgFaint,
        marker: theme.fgMuted,
        icon: theme.fgMuted,
        bold: undefined,
        pointer: "   ",
      };
}
