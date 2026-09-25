/**
 * Toasts (OpenCode's style): a short message in the top-right corner, edged
 * in its kind's colour, gone after a few seconds — or on a click, or `esc`.
 * One at a time; a new one replaces the last. They tell you something
 * happened (or failed) without stopping you.
 */
import { TextAttributes } from "@opentui/core";
import { useEffect, useRef } from "react";
import { type Theme, useTheme } from "../theme";
import { useLive } from "./live";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  kind: ToastKind;
  title?: string;
  message: string;
}

/** How long each kind stays up: failures longest, so there's time to read them. */
const DURATION_MS: Record<ToastKind, number> = { info: 5000, success: 4000, warning: 6000, error: 8000 };

export function useToasts() {
  const [toast, toastRef, setToast] = useLive<(Toast & { id: number }) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nextId = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const dismiss = () => {
    clearTimeout(timer.current);
    setToast(null);
  };
  return {
    toast,
    /** Is one up (current even mid key burst)? */
    shownRef: toastRef,
    show(t: Toast) {
      clearTimeout(timer.current);
      const id = ++nextId.current;
      setToast({ ...t, id });
      timer.current = setTimeout(() => {
        if (toastRef.current?.id === id) setToast(null);
      }, DURATION_MS[t.kind]);
    },
    dismiss,
  };
}

export type Toasts = ReturnType<typeof useToasts>;

function edgeColor(kind: ToastKind, theme: Theme): string {
  switch (kind) {
    case "success":
      return theme.added;
    case "warning":
      return theme.dirty;
    case "error":
      return theme.removed;
    default:
      return theme.accent;
  }
}

export function ToastLayer({ toasts, screenWidth }: { toasts: Toasts; screenWidth: number }) {
  const theme = useTheme();
  const t = toasts.toast;
  if (!t) return null;
  return (
    <box
      position="absolute"
      top={1}
      right={2}
      zIndex={200}
      maxWidth={Math.max(20, Math.min(60, screenWidth - 6))}
      flexDirection="column"
      backgroundColor={theme.panelAlt}
      border={["left", "right"]}
      borderStyle="heavy"
      borderColor={edgeColor(t.kind, theme)}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      onMouseDown={(e) => {
        e.stopPropagation();
        toasts.dismiss();
      }}
    >
      {t.title && (
        <text fg={theme.fg} attributes={TextAttributes.BOLD} marginBottom={1} wrapMode="word">
          {t.title}
        </text>
      )}
      <text fg={theme.fgMuted} wrapMode="word">
        {t.message}
      </text>
    </box>
  );
}
