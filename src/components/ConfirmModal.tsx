import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "../theme";

interface ConfirmModalProps {
  title: string;
  message: string;
  detail?: string;
  /** Omit to render a dismiss-only notice instead of a yes/no prompt. */
  onConfirm?: () => void;
  onCancel: () => void;
}

/** Centered modal: y/⏎ confirms, n/esc/click-outside cancels (or dismisses a notice). */
export function ConfirmModal({
  title,
  message,
  detail,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const theme = useTheme();

  useKeyboard((key) => {
    const name = key.name ?? "";
    if (name === "y" || name === "return") {
      (onConfirm ?? onCancel)();
    } else if (name === "n" || name === "escape") {
      onCancel();
    }
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={150}
      alignItems="center"
      justifyContent="center"
      shouldFill={false}
      onMouseDown={onCancel}
    >
      <box
        width={54}
        borderStyle="rounded"
        border
        borderColor={onConfirm ? theme.removed : theme.accent}
        backgroundColor={theme.panel}
        title={` ${title} `}
        titleAlignment="center"
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        <text fg={theme.fg} wrapMode="word">
          {message}
        </text>
        {detail && (
          <text
            fg={theme.fgFaint}
            attributes={TextAttributes.DIM}
            marginTop={1}
            wrapMode="word"
          >
            {detail}
          </text>
        )}
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM} marginTop={1}>
          {onConfirm ? "y / ⏎ confirm · n / esc cancel" : "⏎ / esc dismiss"}
        </text>
      </box>
    </box>
  );
}
