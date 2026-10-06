/**
 * Toasts: a short message in the top-right corner, in a rounded border and
 * with an icon in its kind's colour, gone after a few seconds — or on a
 * click, or `esc`. One at a time; a new one replaces the last. They tell you
 * something happened (or failed) without stopping you.
 */
import { TextAttributes } from "@opentui/core";
import { useEffect, useRef } from "react";
import { ICON } from "../icons";
import { type Theme, useTheme } from "../theme";
import { useLive } from "./live";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  kind: ToastKind;
  /** In place of its kind's icon. */
  icon?: string;
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

function kindLook(kind: ToastKind, theme: Theme): { glyph: string; color: string } {
  switch (kind) {
    case "success":
      return { glyph: ICON.done, color: theme.added };
    case "warning":
      return { glyph: ICON.warning, color: theme.dirty };
    case "error":
      return { glyph: ICON.failed, color: theme.removed };
    default:
      return { glyph: ICON.info, color: theme.accent };
  }
}

export function ToastLayer({ toasts, screenWidth }: { toasts: Toasts; screenWidth: number }) {
  const theme = useTheme();
  const t = toasts.toast;
  if (!t) return null;
  const look = kindLook(t.kind, theme);
  return (
    <box
      position="absolute"
      top={1}
      right={2}
      zIndex={200}
      maxWidth={Math.max(20, Math.min(60, screenWidth - 6))}
      flexDirection="row"
      backgroundColor={theme.panelAlt}
      border
      borderStyle="rounded"
      borderColor={look.color}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={(e) => {
        e.stopPropagation();
        toasts.dismiss();
      }}
    >
      <text fg={look.color} flexShrink={0}>
        {(t.icon ?? look.glyph) + " "}
      </text>
      <box flexDirection="column" flexShrink={1} minWidth={0}>
        {t.title && (
          <text fg={theme.fg} attributes={TextAttributes.BOLD} marginBottom={1} wrapMode="word">
            {t.title}
          </text>
        )}
        <text fg={theme.fgMuted} wrapMode="word">
          {t.message}
        </text>
      </box>
    </box>
  );
}
