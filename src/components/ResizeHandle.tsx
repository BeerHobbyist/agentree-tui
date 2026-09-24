import { useRef, useState } from "react";
import type { CliRenderer, MouseEvent, Renderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useTheme } from "../theme";

/** Two presses on the divider within this window count as a double-click. */
const DOUBLE_CLICK_MS = 400;

interface ResizeHandleProps {
  /** The pointer's screen column while the divider is being dragged. */
  onDrag: (screenX: number) => void;
  /** The drag finished (button released). */
  onDragEnd: () => void;
  /** Double-click: back to the default width. */
  onReset: () => void;
}

/**
 * Route every mouse event to `renderable` until the button is released.
 *
 * OpenTUI only captures the pointer on the *first drag event*, and captures
 * whatever is under the pointer at that moment. The divider is one column wide,
 * so that first drag is usually already over the terminal — which would then
 * receive the drag and forward it to the program inside (nvim would start a
 * selection). Capturing on mouse-down avoids that. `setCapturedRenderable` is a
 * plain setter the renderer uses for exactly this; it's just not public in the
 * type declarations.
 */
function capturePointer(renderer: CliRenderer, renderable: Renderable | null): void {
  if (!renderable) return;
  (renderer as unknown as { setCapturedRenderable(r: Renderable): void }).setCapturedRenderable(renderable);
}

/**
 * A one-column vertical divider that resizes whatever sits to its left. It
 * draws the same line as a right border, lit in the accent colour while
 * hovered or dragged.
 */
export function ResizeHandle({ onDrag, onDragEnd, onReset }: ResizeHandleProps) {
  const theme = useTheme();
  const renderer = useRenderer();
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Refs, not state: a drag's events arrive faster than React re-renders.
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const downAt = useRef(0);
  /** When the last press that was a plain click (no drag) went down. */
  const lastClickAt = useRef(0);

  const endDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    // Only a press that didn't move can be the first half of a double-click —
    // otherwise re-grabbing the divider right after a drag would reset it.
    lastClickAt.current = movedRef.current ? 0 : downAt.current;
    onDragEnd();
  };

  return (
    <box
      width={1}
      flexShrink={0}
      border={["left"]}
      borderColor={hovered || dragging ? theme.accent : theme.border}
      backgroundColor={theme.panel}
      onMouseDown={(e: MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const now = Date.now();
        if (now - lastClickAt.current < DOUBLE_CLICK_MS) {
          lastClickAt.current = 0;
          onReset();
          return;
        }
        downAt.current = now;
        movedRef.current = false;
        draggingRef.current = true;
        setDragging(true);
        capturePointer(renderer, e.target);
      }}
      onMouseDrag={(e: MouseEvent) => {
        if (!draggingRef.current) return;
        movedRef.current = true;
        onDrag(e.x);
      }}
      onMouseUp={endDrag}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    />
  );
}
