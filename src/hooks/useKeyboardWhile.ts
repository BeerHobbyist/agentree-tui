import { useEffectEvent, useLayoutEffect } from "react";
import type { KeyEvent } from "@opentui/core";
import { useAppContext } from "@opentui/react";

/**
 * `useKeyboard` that only listens while `active`. For components mounted in
 * bulk — a hidden terminal per opened worktree — one keypress listener each
 * would pass EventEmitter's cap of 10, and OpenTUI prints that warning over
 * the screen.
 */
export function useKeyboardWhile(active: boolean, handler: (key: KeyEvent) => void) {
  const { keyHandler } = useAppContext();
  const onKey = useEffectEvent(handler);
  // A layout effect: the keys switch over in the same commit as `active`,
  // leaving no gap for a key to reach a handler that's no longer active.
  useLayoutEffect(() => {
    if (!active || !keyHandler) return;
    keyHandler.on("keypress", onKey);
    return () => {
      keyHandler.off("keypress", onKey);
    };
  }, [active, keyHandler]);
}
