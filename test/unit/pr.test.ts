import { describe, expect, test } from "bun:test";
import type { PrDetails } from "../../src/data/model";
import {
  checkState,
  excerpt,
  mergeStatus,
  relativeTime,
  summarizeChecks,
  toChecks,
  toComments,
  toPrDetails,
  toReviewers,
  type RawPr,
} from "../../src/services/pr";

describe("checkState", () => {
  test("check runs: still running is pending, then by conclusion", () => {
    expect(checkState({ status: "IN_PROGRESS", conclusion: null })).toBe("pending");
    expect(checkState({ status: "QUEUED" })).toBe("pending");
    expect(checkState({ status: "COMPLETED", conclusion: "SUCCESS" })).toBe("pass");
    expect(checkState({ status: "COMPLETED", conclusion: "FAILURE" })).toBe("fail");
    expect(checkState({ status: "COMPLETED", conclusion: "TIMED_OUT" })).toBe("fail");
    expect(checkState({ status: "COMPLETED", conclusion: "CANCELLED" })).toBe("fail");
    expect(checkState({ status: "COMPLETED", conclusion: "SKIPPED" })).toBe("skipped");
    expect(checkState({ status: "COMPLETED", conclusion: "NEUTRAL" })).toBe("skipped");
  });

  test("commit statuses (other CI systems) use `state`", () => {
    expect(checkState({ context: "ci/jenkins", state: "SUCCESS" })).toBe("pass");
    expect(checkState({ context: "ci/jenkins", state: "ERROR" })).toBe("fail");
    expect(checkState({ context: "ci/jenkins", state: "PENDING" })).toBe("pending");
  });
});

describe("summarizeChecks", () => {
  test("any failure wins, then anything running", () => {
    expect(summarizeChecks(["pass", "fail", "pending"])).toBe("fail");
    expect(summarizeChecks(["pass", "pending"])).toBe("pending");
    expect(summarizeChecks(["pass", "skipped"])).toBe("pass");
    expect(summarizeChecks(["skipped"])).toBe("skipped");
    expect(summarizeChecks([])).toBeUndefined();
  });
});

describe("toChecks", () => {
  test("failing first, then running, passing, skipped — and names status contexts", () => {
    const checks = toChecks([
      { name: "build", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "CI" },
      { context: "codecov", state: "PENDING", targetUrl: "https://codecov.io/x" },
      { name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://gh/run/2" },
      { name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
    ]);
    expect(checks.map((c) => `${c.state}:${c.name}`)).toEqual([
      "fail:lint",
      "pending:codecov",
      "pass:build",
      "skipped:docs",
    ]);
    expect(checks[0]!.url).toBe("https://gh/run/2");
    expect(checks[1]!.url).toBe("https://codecov.io/x");
    expect(checks[2]!.workflow).toBe("CI");
  });

  test("no rollup at all", () => {
    expect(toChecks(null)).toEqual([]);
  });
});

describe("toReviewers", () => {
  test("latest verdicts, then still-pending requests, once each", () => {
    expect(
      toReviewers({
        latestReviews: [
          { author: { login: "alice" }, state: "APPROVED" },
          { author: { login: "bob" }, state: "CHANGES_REQUESTED" },
          { author: { login: "dan" }, state: "COMMENTED" },
        ],
        reviewRequests: [{ login: "carol" }, { login: "alice" }, { slug: "core-team" }],
      }),
    ).toEqual([
      { login: "alice", state: "approved" },
      { login: "bob", state: "changes-requested" },
      { login: "dan", state: "commented" },
      { login: "carol", state: "requested" },
      { login: "core-team", state: "requested" },
    ]);
  });
});

describe("toComments", () => {
  test("conversation, review summaries and inline comments, newest first", () => {
    const comments = toComments(
      {
        comments: [{ author: { login: "alice" }, body: "LGTM", createdAt: "2026-09-20T10:00:00Z" }],
        reviews: [
          { author: { login: "bob" }, state: "CHANGES_REQUESTED", body: "See inline.", submittedAt: "2026-09-21T10:00:00Z" },
          { author: { login: "carol" }, state: "APPROVED", body: "", submittedAt: "2026-09-22T10:00:00Z" },
        ],
      },
      [
        {
          user: { login: "bob" },
          body: "Race here.",
          created_at: "2026-09-21T09:00:00Z",
          path: "src/a.ts",
          line: 12,
          html_url: "https://gh/r1",
        },
      ],
    );
    expect(comments.map((c) => `${c.kind}:${c.author}`)).toEqual([
      "review:bob",
      "inline:bob",
      "comment:alice",
    ]); // carol's bare approval has no body, so it isn't a comment
    expect(comments[0]!.reviewState).toBe("changes-requested");
    expect(comments[1]).toMatchObject({ path: "src/a.ts", line: 12, url: "https://gh/r1" });
  });

  test("an outdated inline comment falls back to its original line", () => {
    const [c] = toComments({}, [{ user: { login: "x" }, body: "old", created_at: "", path: "a", line: null, original_line: 7 }]);
    expect(c!.line).toBe(7);
  });
});

const base: RawPr = {
  number: 1,
  title: "t",
  url: "u",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feat",
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  updatedAt: "",
};

describe("toPrDetails", () => {
  test("open, draft, merged and closed", () => {
    expect(toPrDetails(base).state).toBe("open");
    expect(toPrDetails({ ...base, isDraft: true }).state).toBe("draft");
    expect(toPrDetails({ ...base, state: "MERGED" }).state).toBe("merged");
    expect(toPrDetails({ ...base, state: "CLOSED" }).state).toBe("closed");
  });

  test("an empty review decision is no decision", () => {
    expect(toPrDetails({ ...base, reviewDecision: "" }).reviewDecision).toBeNull();
    expect(toPrDetails({ ...base, reviewDecision: "REVIEW_REQUIRED" }).reviewDecision).toBe("review-required");
  });
});

describe("mergeStatus", () => {
  const pr = (over: Partial<PrDetails>): PrDetails => ({ ...toPrDetails(base), ...over });

  test("finished PRs", () => {
    expect(mergeStatus(pr({ state: "merged" })).label).toBe("Merged");
    expect(mergeStatus(pr({ state: "closed" })).tone).toBe("bad");
    expect(mergeStatus(pr({ state: "draft" })).tone).toBe("muted");
  });

  test("conflicts and a stale branch", () => {
    expect(mergeStatus(pr({ mergeable: "CONFLICTING" })).label).toBe("Merge conflicts with main");
    expect(mergeStatus(pr({ mergeStateStatus: "BEHIND" })).label).toBe("Branch is behind main");
  });

  test("blocked says why", () => {
    const blocked = (over: Partial<PrDetails>) => mergeStatus(pr({ mergeStateStatus: "BLOCKED", ...over })).label;
    expect(blocked({ reviewDecision: "changes-requested" })).toBe("Blocked: changes requested");
    expect(blocked({ reviewDecision: "review-required" })).toBe("Blocked: review required");
    expect(blocked({ checks: [{ name: "ci", state: "fail" }] })).toBe("Blocked: failing checks");
    expect(blocked({ checks: [{ name: "ci", state: "pending" }] })).toBe("Blocked: checks running");
    expect(blocked({})).toBe("Blocked by branch protection");
  });

  test("ready, unstable and still computing", () => {
    expect(mergeStatus(pr({ mergeStateStatus: "CLEAN" }))).toEqual({ label: "Ready to merge", tone: "good" });
    expect(mergeStatus(pr({ mergeStateStatus: "UNSTABLE" })).tone).toBe("warn");
    expect(mergeStatus(pr({ mergeStateStatus: "UNKNOWN" })).label).toBe("Checking mergeability…");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  test("buckets", () => {
    expect(relativeTime("2026-09-23T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-09-23T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-09-23T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-21T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("2026-06-01T12:00:00Z", now)).toBe("2026-06-01");
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("excerpt", () => {
  test("keeps short bodies whole and clips long ones", () => {
    expect(excerpt("one\ntwo")).toBe("one\ntwo");
    expect(excerpt("1\n2\n3\n4\n5\n6", 3)).toBe("1\n2\n3 …");
    expect(excerpt("x".repeat(500), 4, 10)).toBe("xxxxxxxxxx …");
  });
});
