import { useTheme } from "../theme";
import { Dialog, rowLook } from "./Dialog";
import { Hints, hintsFrom } from "./Hints";

export interface MenuItem {
  label: string;
  hint?: string;
}

interface MenuOverlayProps {
  title: string;
  items: MenuItem[];
  /** Currently highlighted row (keyboard). */
  index: number;
  /** Activate row i (click or Enter). */
  onPick: (i: number) => void;
  /** Dismiss (click backdrop / Esc). */
  onClose: () => void;
  /** Optional footer note (e.g. an install hint). */
  note?: string;
  width?: number;
}

/** A small list in a dialog, driven by the parent's keyboard + mouse. */
export function MenuOverlay({ title, items, index, onPick, onClose, note, width = 48 }: MenuOverlayProps) {
  const theme = useTheme();
  return (
    <Dialog title={title} width={width} onClose={onClose} zIndex={150}>
      {items.map((item, i) => {
        const look = rowLook(theme, i === index);
        return (
          <box
            key={String(i)}
            flexDirection="row"
            alignItems="center"
            backgroundColor={look.bg}
            onMouseDown={() => onPick(i)}
          >
            <text fg={look.marker} flexShrink={0}>
              {i === index ? " ▶ " : "   "}
            </text>
            <text fg={look.fg} attributes={look.bold} flexShrink={0}>
              {item.label}
            </text>
            {item.hint ? (
              <text fg={look.muted} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
                {"  " + item.hint}
              </text>
            ) : null}
          </box>
        );
      })}
      {note && (
        <text fg={theme.fgMuted} marginTop={1} wrapMode="word">
          {note}
        </text>
      )}
      <Hints marginTop={1} hints={hintsFrom("↑↓ move · ⏎ select · esc cancel")} />
    </Dialog>
  );
}
