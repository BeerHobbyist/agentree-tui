/**
 * Every piece of data the app fetches, as TanStack Query options: its cache
 * key, how to fetch it, and how long it stays fresh / how often it's polled.
 * Components use these with `useQuery`; invalidating a key (see `queryKeys`)
 * refetches whatever is on screen and marks the rest stale.
 *
 * Defaults (src/queryClient.ts): fresh for 30s, dropped 10 min after nothing
 * shows it, one retry, refetched when stale and the terminal regains focus.
 *
 * GitHub queries pause their polling while the terminal isn't focused (they
 * catch up on return). Local ones — agent status, git status, tmux tabs — keep
 * polling in the background (`refetchIntervalInBackground`), since agentree may
 * be on screen without keyboard focus, and that's when "needs action" matters.
 */
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { PrInfo } from "./data/model";
import { readAgentStatuses, type AgentReport } from "./services/agents";
import { fetchRepoPage, listOpenPrs, prForBranch } from "./services/gh";
import { baseRef, status as gitStatus } from "./services/git";
import { isAvailable as hunkAvailable } from "./services/hunk";
import { createLimiter } from "./services/limit";
import { fetchMergeSettings, fetchPrDetails } from "./services/pr";
import { isAvailable as tmuxAvailable, tmuxOn } from "./services/tmux";

/** How often the PR on screen is re-fetched. */
export const PR_DETAILS_REFRESH_MS = 30_000;
/** How often each worktree's PR is looked up again. */
export const PR_LOOKUP_MS = 60_000;
/** How often each worktree's git status is refreshed. */
export const GIT_STATUS_MS = 5_000;
/** How often agent status is read (local files — cheap). */
export const AGENT_STATUS_MS = 1_000;
/** How often the visible terminal's tab bar re-reads tmux windows. */
export const TMUX_WINDOWS_MS = 1_000;
/** How long the list of your GitHub repos counts as fresh. */
export const REPOS_STALE_MS = 10 * 60_000;

/** At most 4 `gh` / `git` processes at a time. */
const limited = createLimiter(4);

export const queryKeys = {
  prDetails: (repo: string, number: number) => ["pr-details", repo, number] as const,
  mergeSettings: (repo: string) => ["merge-settings", repo] as const,
  prForBranch: (repo: string, branch: string) => ["pr-for-branch", repo, branch] as const,
  allPrForBranch: ["pr-for-branch"] as const,
  gitStatus: (path: string) => ["git-status", path] as const,
  allGitStatus: ["git-status"] as const,
  agentStatus: ["agent-status"] as const,
  repos: ["repos"] as const,
  openPrs: (repo: string) => ["open-prs", repo] as const,
  tmuxAvailable: ["tmux-available"] as const,
  hunkAvailable: ["hunk-available"] as const,
  tmuxWindows: (session: string) => ["tmux-windows", session] as const,
  baseRef: (path: string) => ["base-ref", path] as const,
};

/** The PR panel's details for one PR — polled while on screen. */
export const prDetailsQuery = (repo: string, number: number) =>
  queryOptions({
    queryKey: queryKeys.prDetails(repo, number),
    queryFn: () => fetchPrDetails(repo, number),
    refetchInterval: PR_DETAILS_REFRESH_MS,
  });

/** Which merge methods a repo allows, and whether auto-merge is on — settings rarely change. */
export const mergeSettingsQuery = (repo: string) =>
  queryOptions({
    queryKey: queryKeys.mergeSettings(repo),
    queryFn: () => fetchMergeSettings(repo),
    staleTime: 10 * 60_000,
  });

/** A worktree branch's open PR (the sidebar badge), or null. */
export const prForBranchQuery = (repo: string, branch: string) =>
  queryOptions({
    queryKey: queryKeys.prForBranch(repo, branch),
    queryFn: (): Promise<PrInfo | null> => limited(() => prForBranch(repo, branch)),
    staleTime: PR_LOOKUP_MS,
    refetchInterval: PR_LOOKUP_MS,
  });

/** Dirty / changed files / +− / ahead-behind for a worktree on disk. */
export const gitStatusQuery = (path: string) =>
  queryOptions({
    queryKey: queryKeys.gitStatus(path),
    queryFn: () => limited(() => gitStatus(path)),
    staleTime: 0,
    refetchInterval: GIT_STATUS_MS,
    refetchIntervalInBackground: true,
  });

/**
 * Every tmux session's agent status. A plain object rather than a Map, so an
 * unchanged answer keeps its identity (structural sharing) and re-renders
 * nothing.
 */
export const agentStatusQuery = () =>
  queryOptions({
    queryKey: queryKeys.agentStatus,
    queryFn: async (): Promise<Record<string, AgentReport>> =>
      Object.fromEntries(await readAgentStatuses()),
    staleTime: 0,
    refetchInterval: AGENT_STATUS_MS,
    refetchIntervalInBackground: true,
    retry: false,
  });

/** Every repo `gh` can see, a page at a time (the modal loads the rest in the background). */
export const reposQuery = () =>
  infiniteQueryOptions({
    queryKey: queryKeys.repos,
    queryFn: ({ pageParam }) => fetchRepoPage(pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    staleTime: REPOS_STALE_MS,
  });

/** A repo's open PRs, offered as one-key picks in the modal (best-effort: [] on failure). */
export const openPrsQuery = (repo: string) =>
  queryOptions({
    queryKey: queryKeys.openPrs(repo),
    queryFn: () => listOpenPrs(repo),
  });

/** Installed binaries don't come and go while the app runs: checked once, shared by every terminal. */
export const tmuxAvailableQuery = () =>
  queryOptions({
    queryKey: queryKeys.tmuxAvailable,
    queryFn: tmuxAvailable,
    staleTime: Infinity,
    gcTime: Infinity,
  });
export const hunkAvailableQuery = () =>
  queryOptions({
    queryKey: queryKeys.hunkAvailable,
    queryFn: hunkAvailable,
    staleTime: Infinity,
    gcTime: Infinity,
  });

/** A session's windows (tabs) for the tab bar. */
/**
 * A session's windows (tabs) — on `host` over ssh for an SSH project; only over
 * a live connection for a host that logs in with a password.
 */
export const tmuxWindowsQuery = (session: string, host?: string, onlyIfConnected = false) =>
  queryOptions({
    queryKey: queryKeys.tmuxWindows(session),
    queryFn: () => tmuxOn(host, { onlyIfConnected }).listWindows(session),
    staleTime: 0,
    refetchInterval: TMUX_WINDOWS_MS,
    refetchIntervalInBackground: true,
    retry: false,
  });

/** The branch a worktree's "vs base" diff compares against — rarely changes. */
export const baseRefQuery = (path: string) =>
  queryOptions({
    queryKey: queryKeys.baseRef(path),
    queryFn: () => baseRef(path),
    staleTime: 5 * 60_000,
  });
