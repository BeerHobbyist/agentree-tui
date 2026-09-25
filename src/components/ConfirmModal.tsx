import { useKeyboard } from "@opentui/react";
import { useTheme } from "../theme";
import { Dialog } from "./Dialog";
import { Hints, hintsFrom } from "./Hints";

interface ConfirmModalProps {
  title: string;
  message: string;
  detail?: string;
  /** Omit to render a dismiss-only notice instead of a yes/no prompt. */
  onConfirm?: () => void;
  onCancel: () => void;
}

/** y/⏎ confirms, n/esc/click-outside cancels (or, without onConfirm, dismisses). */
export function ConfirmModal({ title, message, detail, onConfirm, onCancel }: ConfirmModalProps) {
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
    <Dialog title={title} width={58} onClose={onCancel} titleColor={onConfirm ? theme.removed : undefined} zIndex={150}>
      <text fg={theme.fg} wrapMode="word">
        {message}
      </text>
      {detail && (
        <text fg={theme.fgMuted} marginTop={1} wrapMode="word">
          {detail}
        </text>
      )}
      <Hints marginTop={1} hints={hintsFrom(onConfirm ? "y / ⏎ confirm · n / esc cancel" : "⏎ / esc dismiss")} />
    </Dialog>
  );
}
