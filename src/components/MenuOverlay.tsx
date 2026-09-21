import { TextAttributes } from "@opentui/core";
import { useTheme } from "../theme";

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

/** Small centered overlay list, driven by the parent's keyboard + mouse. */
export function MenuOverlay({
  title,
  items,
  index,
  onPick,
  onClose,
  note,
  width = 44,
}: MenuOverlayProps) {
  const theme = useTheme();
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
      onMouseDown={onClose}
    >
      <box
        width={width}
        borderStyle="rounded"
        border
        borderColor={theme.accent}
        backgroundColor={theme.panel}
        title={` ${title} `}
        titleAlignment="center"
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        {items.map((item, i) => {
          const active = i === index;
          return (
            <box
              key={String(i)}
              flexDirection="row"
              alignItems="center"
              onMouseDown={() => onPick(i)}
            >
              <text fg={active ? theme.accent : theme.panel} flexShrink={0}>
                {active ? "▶ " : "  "}
              </text>
              <text
                fg={active ? theme.fg : theme.fgMuted}
                attributes={active ? TextAttributes.BOLD : undefined}
                flexShrink={0}
              >
                {item.label}
              </text>
              {item.hint ? (
                <text
                  fg={theme.fgFaint}
                  attributes={TextAttributes.DIM}
                  flexGrow={1}
                  flexShrink={1}
                  minWidth={0}
                  wrapMode="none"
                  truncate
                >
                  {"  " + item.hint}
                </text>
              ) : null}
            </box>
          );
        })}
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM} marginTop={1}>
          {note ?? "↑↓ move · ⏎ select · esc cancel"}
        </text>
      </box>
    </box>
  );
}
