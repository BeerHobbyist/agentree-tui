/**
 * Animation: one clock every animated glyph shares — ticking only while one is
 * on screen — and the frames they show. `AGENTREE_ANIMATIONS=off` keeps them
 * still (their static glyphs), for slow links or taste; the test sandbox sets it.
 */
import { useSyncExternalStore } from "react";

export const TICK_MS = 80;

/** The working spinner: braille dots, one step a tick (as OpenCode's). */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The needs-action pulse: how far the glyph fades toward the background on
 * each tick — a slow breath (1.6s), never quite gone.
 */
export const PULSE = Array.from({ length: 20 }, (_, i) => ((1 - Math.cos((i / 20) * 2 * Math.PI)) / 2) * 0.7);

export function animationsOn(): boolean {
  return process.env.AGENTREE_ANIMATIONS !== "off";
}

let tick = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      tick++;
      for (const l of listeners) l();
    }, TICK_MS);
    timer.unref?.();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const still = () => () => {};

/** The shared clock's tick while `active` (and animations are on) — re-rendering on each — else 0. */
export function useTick(active: boolean): number {
  const on = active && animationsOn();
  return useSyncExternalStore(on ? subscribe : still, () => (on ? tick : 0));
}
