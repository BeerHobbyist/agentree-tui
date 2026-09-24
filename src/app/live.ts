/**
 * State the keyboard handler can read current.
 *
 * `useKeyboard`'s handler reads state through refs, and a burst of keys (key
 * repeat, a paste) arrives in one tick, before React re-renders: a ref only
 * refreshed on render would hand every key the same stale value — holding `j`
 * would move one row. So a write updates the ref at once, and each render
 * catches it up with whatever React holds.
 */
import { useRef, useState, type RefObject } from "react";

export type Live<T> = readonly [value: T, ref: RefObject<T>, set: (next: T) => void];

export function useLive<T>(initial: T | (() => T)): Live<T> {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  ref.current = value;
  const set = useRef((next: T) => {
    ref.current = next;
    setValue(() => next);
  }).current;
  return [value, ref, set] as const;
}

/** A ref that holds the latest value of something computed while rendering. */
export function useMirror<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
