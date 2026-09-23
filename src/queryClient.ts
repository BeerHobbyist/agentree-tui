/**
 * TanStack Query setup: caches data fetched from GitHub so moving between
 * worktrees shows what was already loaded instead of fetching it again.
 *
 * Fresh data (younger than STALE_MS) is shown as-is. Stale data is still shown
 * straight away, and refreshed in the background. A query nothing is showing
 * is dropped after GC_MS.
 */
import { environmentManager, QueryClient, type DefaultOptions } from "@tanstack/react-query";

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
        // There's no window to focus or network to reconnect — refreshes are explicit.
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        ...overrides,
      },
    },
  });
}
