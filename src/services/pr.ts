/**
 * Pull request details for the PR panel, via `gh`: one `gh pr view --json` for
 * the PR itself, checks, reviews and conversation, plus the REST API for inline
 * code comments (not part of `gh pr view`). Everything is normalized into
 * `PrDetails` by pure functions, exported for tests.
 */
import type {
  CheckState,
  PrCheck,
  PrComment,
  PrDetails,
  PrReviewer,
} from "../data/model";
import { run } from "./proc";

/** A `statusCheckRollup` entry: a GitHub Actions/app CheckRun or a commit StatusContext. */
export interface RawCheck {
  __typename?: string;
  name?: string;
  workflowName?: string;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  context?: string | null;
  state?: string | null;
  targetUrl?: string | null;
}

interface RawAuthor {
  login?: string;
}

/** The subset of `gh pr view --json` we ask for. */
export interface RawPr {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  author?: RawAuthor | null;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  latestReviews?: { author?: RawAuthor | null; state?: string }[];
  reviewRequests?: { login?: string; name?: string; slug?: string }[];
  reviews?: { author?: RawAuthor | null; state?: string; body?: string; submittedAt?: string }[];
  comments?: { author?: RawAuthor | null; body?: string; createdAt?: string; url?: string }[];
  labels?: { name: string }[];
  statusCheckRollup?: RawCheck[] | null;
  body?: string;
}

/** An inline review comment from `GET /repos/{repo}/pulls/{n}/comments`. */
export interface RawInlineComment {
  user?: RawAuthor | null;
  body?: string;
  created_at?: string;
  html_url?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
}

export const PR_VIEW_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "author",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "additions",
  "deletions",
  "changedFiles",
  "updatedAt",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "latestReviews",
  "reviewRequests",
  "reviews",
  "comments",
  "labels",
  "statusCheckRollup",
  "body",
].join(",");

/** Where one check stands. */
export function checkState(c: RawCheck): CheckState {
  // Commit statuses (other CI systems) report `state`; check runs report status + conclusion.
  if (c.state) {
    switch (c.state.toUpperCase()) {
      case "SUCCESS":
        return "pass";
      case "FAILURE":
      case "ERROR":
        return "fail";
      default:
        return "pending"; // PENDING, EXPECTED
    }
  }
  if (c.status && c.status.toUpperCase() !== "COMPLETED") return "pending";
  switch ((c.conclusion ?? "").toUpperCase()) {
    case "SUCCESS":
      return "pass";
    case "NEUTRAL":
    case "SKIPPED":
    case "STALE":
      return "skipped";
    case "FAILURE":
    case "TIMED_OUT":
    case "CANCELLED":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "fail";
    default:
      return "pending";
  }
}

/** A PR's checks overall: any failure wins, then anything still running. */
export function summarizeChecks(states: CheckState[]): CheckState | undefined {
  if (states.includes("fail")) return "fail";
  if (states.includes("pending")) return "pending";
  if (states.includes("pass")) return "pass";
  return states.length > 0 ? "skipped" : undefined;
}

const CHECK_ORDER: CheckState[] = ["fail", "pending", "pass", "skipped"];

export function toChecks(raw: RawCheck[] | null | undefined): PrCheck[] {
  return (raw ?? [])
    .map((c) => ({
      name: c.name ?? c.context ?? "check",
      ...(c.workflowName ? { workflow: c.workflowName } : {}),
      state: checkState(c),
      ...((c.detailsUrl ?? c.targetUrl) ? { url: (c.detailsUrl ?? c.targetUrl)! } : {}),
    }))
    .sort(
      (a, b) =>
        CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state) || a.name.localeCompare(b.name),
    );
}

function reviewerState(state: string | undefined): PrReviewer["state"] {
  switch ((state ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "DISMISSED":
      return "dismissed";
    default:
      return "commented";
  }
}

export function toReviewers(pr: Pick<RawPr, "latestReviews" | "reviewRequests">): PrReviewer[] {
  const reviewers: PrReviewer[] = [];
  const seen = new Set<string>();
  for (const r of pr.latestReviews ?? []) {
    const login = r.author?.login;
    if (!login || seen.has(login)) continue;
    seen.add(login);
    reviewers.push({ login, state: reviewerState(r.state) });
  }
  for (const r of pr.reviewRequests ?? []) {
    const login = r.login ?? r.slug ?? r.name;
    if (!login || seen.has(login)) continue;
    seen.add(login);
    reviewers.push({ login, state: "requested" });
  }
  return reviewers;
}

/** Conversation, review summaries and inline comments, newest first. */
export function toComments(pr: Pick<RawPr, "comments" | "reviews">, inline: RawInlineComment[]): PrComment[] {
  const out: PrComment[] = [];
  for (const c of pr.comments ?? []) {
    if (!c.body?.trim()) continue;
    out.push({
      kind: "comment",
      author: c.author?.login ?? "unknown",
      body: c.body,
      createdAt: c.createdAt ?? "",
      ...(c.url ? { url: c.url } : {}),
    });
  }
  for (const r of pr.reviews ?? []) {
    if (!r.body?.trim()) continue; // a bare approval has no body
    out.push({
      kind: "review",
      author: r.author?.login ?? "unknown",
      body: r.body,
      createdAt: r.submittedAt ?? "",
      reviewState: reviewerState(r.state),
    });
  }
  for (const c of inline) {
    if (!c.body?.trim()) continue;
    const line = c.line ?? c.original_line ?? undefined;
    out.push({
      kind: "inline",
      author: c.user?.login ?? "unknown",
      body: c.body,
      createdAt: c.created_at ?? "",
      ...(c.html_url ? { url: c.html_url } : {}),
      ...(c.path ? { path: c.path } : {}),
      ...(line ? { line } : {}),
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function prState(pr: RawPr): PrDetails["state"] {
  switch (pr.state.toUpperCase()) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return pr.isDraft ? "draft" : "open";
  }
}

function reviewDecision(d: string | null | undefined): PrDetails["reviewDecision"] {
  switch ((d ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "review-required";
    default:
      return null;
  }
}

export function toPrDetails(pr: RawPr, inline: RawInlineComment[] = []): PrDetails {
  return {
    number: pr.number,
    title: pr.title ?? "",
    url: pr.url ?? "",
    state: prState(pr),
    author: pr.author?.login ?? "",
    base: pr.baseRefName ?? "",
    head: pr.headRefName ?? "",
    headSha: pr.headRefOid ?? "",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? 0,
    updatedAt: pr.updatedAt ?? "",
    mergeStateStatus: (pr.mergeStateStatus ?? "UNKNOWN").toUpperCase(),
    mergeable: (pr.mergeable ?? "UNKNOWN").toUpperCase(),
    reviewDecision: reviewDecision(pr.reviewDecision),
    reviewers: toReviewers(pr),
    checks: toChecks(pr.statusCheckRollup),
    labels: (pr.labels ?? []).map((l) => l.name),
    body: pr.body ?? "",
    comments: toComments(pr, inline),
  };
}

/** How the merge box reads, and in which tone. */
export type Tone = "good" | "bad" | "warn" | "muted" | "merged";

export function mergeStatus(d: PrDetails): { label: string; tone: Tone } {
  if (d.state === "merged") return { label: "Merged", tone: "merged" };
  if (d.state === "closed") return { label: "Closed without merging", tone: "bad" };
  if (d.state === "draft") return { label: "Draft — not ready for review", tone: "muted" };
  const checks = summarizeChecks(d.checks.map((c) => c.state));
  if (d.mergeable === "CONFLICTING" || d.mergeStateStatus === "DIRTY") {
    return { label: "Merge conflicts with " + (d.base || "the base branch"), tone: "bad" };
  }
  switch (d.mergeStateStatus) {
    case "BEHIND":
      return { label: "Branch is behind " + (d.base || "the base branch"), tone: "warn" };
    case "BLOCKED":
      if (d.reviewDecision === "changes-requested") return { label: "Blocked: changes requested", tone: "bad" };
      if (d.reviewDecision === "review-required") return { label: "Blocked: review required", tone: "warn" };
      if (checks === "fail") return { label: "Blocked: failing checks", tone: "bad" };
      if (checks === "pending") return { label: "Blocked: checks running", tone: "warn" };
      return { label: "Blocked by branch protection", tone: "warn" };
    case "UNSTABLE":
      return { label: "Mergeable, but some checks failed", tone: "warn" };
    case "CLEAN":
    case "HAS_HOOKS":
      return { label: "Ready to merge", tone: "good" };
    default:
      if (checks === "pending") return { label: "Checks running", tone: "warn" };
      return { label: "Checking mergeability…", tone: "muted" };
  }
}

/** "just now", "5m ago", "3h ago", "2d ago", or a date for anything older than a month. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.round(s / 86_400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** First few lines of a body, for previews. */
export function excerpt(body: string, maxLines = 4, maxChars = 280): string {
  const lines = body.replace(/\r/g, "").trim().split("\n");
  let text = lines.slice(0, maxLines).join("\n");
  const clipped = lines.length > maxLines || text.length > maxChars;
  if (text.length > maxChars) text = text.slice(0, maxChars).trimEnd();
  return clipped ? text + " …" : text;
}

/** Fetch and normalize a PR. Inline comments are best-effort; the PR itself must load. */
export async function fetchPrDetails(nameWithOwner: string, number: number): Promise<PrDetails> {
  const [view, inline] = await Promise.all([
    run(["gh", "pr", "view", String(number), "-R", nameWithOwner, "--json", PR_VIEW_FIELDS]),
    run(["gh", "api", `repos/${nameWithOwner}/pulls/${number}/comments?per_page=100`]).catch(
      () => null,
    ),
  ]);
  if (view.code !== 0) {
    throw new Error(view.stderr.trim().split("\n").pop() || `gh pr view exited ${view.code}`);
  }
  let inlineComments: RawInlineComment[] = [];
  if (inline && inline.code === 0) {
    try {
      const parsed = JSON.parse(inline.stdout);
      if (Array.isArray(parsed)) inlineComments = parsed;
    } catch {
      // not fatal — show the PR without inline comments
    }
  }
  return toPrDetails(JSON.parse(view.stdout) as RawPr, inlineComments);
}

// --- merging ---

/** How a PR gets into its base: GitHub's three merge buttons. */
export type MergeMethod = "squash" | "merge" | "rebase";

export const MERGE_METHODS: {
  method: MergeMethod;
  label: string;
  /** "#42 will ___ into main": for auto-merge. */
  verb: string;
  /** The confirm question for merging now. */
  ask: (pr: string, into: string) => string;
}[] = [
  { method: "squash", label: "Squash and merge", verb: "squash-merge", ask: (pr, into) => `Squash and merge ${pr} into ${into}?` },
  { method: "merge", label: "Create a merge commit", verb: "merge", ask: (pr, into) => `Merge ${pr} into ${into} with a merge commit?` },
  { method: "rebase", label: "Rebase and merge", verb: "rebase-merge", ask: (pr, into) => `Rebase and merge ${pr} into ${into}?` },
];

/** What a repo's settings allow when merging. */
export interface MergeSettings {
  methods: MergeMethod[];
  /** "Allow auto-merge" is on: a blocked PR can be set to merge once it's ready. */
  autoMerge: boolean;
}

/**
 * Read a repo's merge settings from `GET /repos/{repo}`. GitHub only includes
 * the `allow_*` fields for people with push access; when they're missing,
 * every method is offered and GitHub has the final say.
 */
export function toMergeSettings(raw: Record<string, unknown>): MergeSettings {
  const allowed = (key: string) => raw[key] !== false;
  const methods = MERGE_METHODS.map((m) => m.method).filter((m) =>
    allowed(m === "merge" ? "allow_merge_commit" : `allow_${m}_merge`),
  );
  return { methods, autoMerge: raw.allow_auto_merge === true };
}

export async function fetchMergeSettings(nameWithOwner: string): Promise<MergeSettings> {
  const { code, stdout, stderr } = await run(["gh", "api", `repos/${nameWithOwner}`]);
  if (code !== 0) throw new Error(stderr.trim().split("\n").pop() || `gh api exited ${code}`);
  return toMergeSettings(JSON.parse(stdout) as Record<string, unknown>);
}

/**
 * Whether a PR can be merged from here: `now` (merge straight away), `auto`
 * (enable auto-merge, for a PR that's blocked but otherwise fine), or neither —
 * with `reason` saying why.
 */
export function mergeOptions(
  d: PrDetails,
  settings: MergeSettings,
): { now: boolean; auto: boolean; reason?: string } {
  const status = mergeStatus(d).label;
  if (d.state !== "open") return { now: false, auto: false, reason: status };
  if (d.mergeable === "CONFLICTING" || d.mergeStateStatus === "DIRTY") {
    return { now: false, auto: false, reason: status };
  }
  switch (d.mergeStateStatus) {
    case "BLOCKED":
    case "BEHIND":
      return settings.autoMerge
        ? { now: false, auto: true, reason: status }
        : { now: false, auto: false, reason: `${status} — and auto-merge is off for this repo` };
    default:
      // CLEAN, HAS_HOOKS, UNSTABLE (only non-required checks failed), and
      // UNKNOWN (GitHub hasn't worked it out yet): let GitHub decide.
      return { now: true, auto: false };
  }
}

/**
 * Merge a PR (or, with `auto`, set it to merge once it's ready) on GitHub.
 * Pinned to `headSha` when known, so a push you haven't seen yet isn't merged.
 * Doesn't delete branches — the repo's own "delete head branch" setting applies,
 * and the worktree keeps its local branch. Resolves to gh's message.
 */
export async function mergePr(
  nameWithOwner: string,
  number: number,
  method: MergeMethod,
  opts: { auto?: boolean; headSha?: string } = {},
): Promise<string> {
  const args = ["gh", "pr", "merge", String(number), "-R", nameWithOwner, `--${method}`];
  if (opts.auto) args.push("--auto");
  if (opts.headSha) args.push("--match-head-commit", opts.headSha);
  const { code, stdout, stderr } = await run(args);
  if (code !== 0) throw new Error(stderr.trim().split("\n").pop() || `gh pr merge exited ${code}`);
  return (stdout.trim() || stderr.trim()).split("\n").pop() ?? "";
}
