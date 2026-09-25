/**
 * TanStack Query setup: caches data fetched from GitHub so moving between
 * worktrees shows what was already loaded instead of fetching it again.
 *
 * Fresh data (younger than STALE_MS) is shown as-is. Stale data is still shown
 * straight away, and refreshed in the background. A query nothing is showing
 * is dropped after GC_MS.
 */
import { environmentManager, focusManager, QueryClient, type DefaultOptions } from "@tanstack/react-query";

// TanStack treats a runtime without `window` as a server: refetch timers off,
// entries kept forever, no retries. This is a long-lived interactive client —
// the case `setIsServer` exists for (it's the documented Service Worker fix).
environmentManager.setIsServer(() => false);

/** How long fetched data counts as fresh — coming back within this fetches nothing. */
export const STALE_MS = 30_000;
/** How long data nothing is showing stays cached. */
export const GC_MS = 10 * 60_000;

export function createQueryClient(overrides: DefaultOptions["queries"] = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_MS,
        gcTime: GC_MS,
        // `gh` failures are rarely transient (not found, not logged in): one retry, quickly.
        retry: 1,
        retryDelay: 1000,
        // "Window focus" is the terminal's (see bindTerminalFocus): coming back
        // to it refreshes anything stale. There's no network event to hook.
        refetchOnWindowFocus: true,
        refetchOnReconnect: false,
        ...overrides,
      },
    },
  });
}

/** The renderer's terminal focus events (OpenTUI emits them when the terminal reports focus). */
interface FocusSource {
  on(event: "focus" | "blur", listener: () => void): unknown;
  off(event: "focus" | "blur", listener: () => void): unknown;
}

/**
 * Drive TanStack's focus state from the terminal window's, the way a browser
 * drives it from the tab: switching back to the terminal refreshes anything
 * stale, and queries that don't poll in the background (the GitHub ones) pause
 * while you're elsewhere. OpenTUI only turns on focus reporting (DEC mode 1004)
 * when the terminal says it supports it; without it no event ever arrives and
 * the app simply counts as focused, as before. Returns a cleanup.
 *
 * TanStack's focus state is global, so each binding starts from "focused" and a
 * cleanup only undoes its own binding — an app's unmount can land after the
 * next app has bound (tests render one after another).
 */
let latestBinding = 0;
export function bindTerminalFocus(source: FocusSource): () => void {
  const binding = ++latestBinding;
  focusManager.setFocused(undefined);
  focusManager.setEventListener((setFocused) => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    source.on("focus", onFocus);
    source.on("blur", onBlur);
    return () => {
      source.off("focus", onFocus);
      source.off("blur", onBlur);
    };
  });
  return () => {
    if (binding !== latestBinding) return; // a newer app has taken over
    focusManager.setEventListener(() => undefined); // detach from this renderer
    focusManager.setFocused(undefined); // back to "unknown", which counts as focused
  };
}
