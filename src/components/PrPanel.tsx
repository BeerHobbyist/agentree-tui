import { useEffect, useRef, type RefObject } from "react";
import { TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { useTheme, type Theme } from "../theme";
import { ICON } from "../icons";
import { Hints } from "./Hints";
import type { CheckState, PrDetails, PrInfo, PrReviewer } from "../data/model";
import { excerpt, mergeStatus, relativeTime, summarizeChecks, type Tone } from "../services/pr";
import { useQuery } from "@tanstack/react-query";
import { prDetailsQuery } from "../queries";
import { openExternal } from "../services/open";
import { ResizeHandle } from "./ResizeHandle";

/** Comments shown before "…N more on GitHub". */
const MAX_COMMENTS = 20;

/** The panel's foldable sections. */
export const PR_SECTIONS = ["merge", "reviews", "checks", "labels", "description", "comments"] as const;
export type PrSection = (typeof PR_SECTIONS)[number];

/** What the app can do to the panel from its keys. */
export interface PrPanelHandle {
  refresh(): void;
  scroll(lines: number): void;
}

interface PrPanelProps {
  /** `owner/name` of the repo. */
  repo: string;
  /** The PR as the sidebar knows it — shown while details load. */
  pr: PrInfo;
  width: number;
  onResize: (width: number) => void;
  onResizeEnd: () => void;
  onResetWidth: () => void;
  onClose: () => void;
  /** Open the merge prompt for this PR (`m`, or the Merge button). */
  onMerge?: () => void;
  /** Once it's merged: close the worktree it came from (the Close button). */
  onCloseWorktree?: () => void;
  /** The key that closes that worktree from the sidebar, when it's the one selected there. */
  closeKey?: string;
  /** Sections folded away (click a section's header to fold / unfold it). */
  collapsed?: readonly PrSection[];
  onToggleSection?: (section: PrSection) => void;
  handleRef?: RefObject<PrPanelHandle | null>;
}

export function checkLook(state: CheckState | undefined, theme: Theme): { glyph: string; color: string } {
  switch (state) {
    case "pass":
      return { glyph: "✓", color: theme.added };
    case "fail":
      return { glyph: "✗", color: theme.removed };
    case "pending":
      return { glyph: "◌", color: theme.dirty };
    case "skipped":
      return { glyph: "–", color: theme.fgFaint };
    default:
      return { glyph: "", color: theme.fgMuted };
  }
}

/**
 * A worktree's PR as a badge (the sidebar's, the tab bar's): the PR icon and
 * `#42` while open (the draft icon for a draft), coloured by its checks; the
 * merge icon once merged.
 */
export function prBadge(pr: PrInfo, theme: Theme): { text: string; color: string } {
  if (pr.merged) return { text: `${ICON.merged} #${pr.number}`, color: theme.agentWaiting };
  const color = pr.checks ? checkLook(pr.checks, theme).color : pr.draft ? theme.fgMuted : theme.added;
  return { text: `${pr.draft ? ICON.prDraft : ICON.pr} #${pr.number}`, color };
}

function toneColor(tone: Tone, theme: Theme): string {
  switch (tone) {
    case "good":
      return theme.added;
    case "bad":
      return theme.removed;
    case "warn":
      return theme.dirty;
    case "merged":
      return theme.agentWaiting;
    default:
      return theme.fgMuted;
  }
}

function reviewerLook(state: PrReviewer["state"], theme: Theme): { glyph: string; color: string; label: string } {
  switch (state) {
    case "approved":
      return { glyph: "✓", color: theme.added, label: "approved" };
    case "changes-requested":
      return { glyph: "✗", color: theme.removed, label: "changes requested" };
    case "requested":
      return { glyph: "◌", color: theme.dirty, label: "review requested" };
    case "dismissed":
      return { glyph: "–", color: theme.fgFaint, label: "dismissed" };
    default:
      return { glyph: "●", color: theme.fgMuted, label: "commented" };
  }
}

const STATE_LABEL: Record<PrDetails["state"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/**
 * A titled block; clicking its title folds it down to that line. `extra`
 * (counts, a verdict) shows either way, `folded` only while folded.
 */
function Section({
  title,
  extra,
  folded,
  collapsed = false,
  onToggle,
  children,
}: {
  title: string;
  extra?: React.ReactNode;
  folded?: React.ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      <box flexDirection="row" flexShrink={0} onMouseDown={onToggle}>
        <text fg={theme.fgFaint} flexShrink={0}>
          {collapsed ? "▸ " : "▾ "}
        </text>
        <text fg={theme.fg} attributes={TextAttributes.BOLD} flexShrink={0}>
          {title}
        </text>
        {extra}
        {collapsed && folded}
      </box>
      {!collapsed && (
        // Glyphs line up under the title.
        <box flexDirection="column" flexShrink={0} paddingLeft={2}>
          {children}
        </box>
      )}
    </box>
  );
}

/** A block of quoted text (a comment, the description) set off by a rule on its left. */
function Quote({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexShrink={0} border={["left"]} borderColor={theme.border} paddingLeft={1}>
      <text fg={theme.fgMuted} flexShrink={0}>
        {children}
      </text>
    </box>
  );
}

/** One line: a coloured glyph, then text that truncates. */
function Row({
  glyph,
  color,
  text,
  dim,
  onClick,
}: {
  glyph: string;
  color: string;
  text: string;
  dim?: string;
  onClick?: () => void;
}) {
  const theme = useTheme();
  return (
    <box flexDirection="row" flexShrink={0} onMouseDown={onClick}>
      <text fg={color} flexShrink={0}>
        {glyph + " "}
      </text>
      <text fg={theme.fg} flexShrink={1} minWidth={0} wrapMode="none" truncate>
        {text}
      </text>
      {dim && (
        <text fg={theme.fgFaint} flexShrink={0} wrapMode="none">
          {" · " + dim}
        </text>
      )}
    </box>
  );
}

/**
 * The PR of the worktree on screen: status, merge readiness, reviews, checks,
 * labels, description and comments. Fetches on open, then every PR_REFRESH_MS.
 */
export function PrPanel({
  repo,
  pr,
  width,
  onResize,
  onResizeEnd,
  onResetWidth,
  onClose,
  onMerge,
  onCloseWorktree,
  closeKey,
  collapsed = [],
  onToggleSection,
  handleRef,
}: PrPanelProps) {
  const theme = useTheme();
  const rootRef = useRef<BoxRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  // Cached per PR (src/queries.ts): coming back to a PR seen recently shows
  // it immediately; stale data is refreshed in the background.
  const query = useQuery(prDetailsQuery(repo, pr.number));
  const details = query.data ?? null;
  const error = query.error ? (query.error instanceof Error ? query.error.message : String(query.error)) : null;

  // A different PR starts at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo(0);
  }, [repo, pr.number]);

  if (handleRef) {
    handleRef.current = {
      refresh: () => void query.refetch(),
      scroll: (lines) => scrollRef.current?.scrollBy(lines),
    };
  }
  useEffect(
    () => () => {
      if (handleRef) handleRef.current = null;
    },
    [handleRef],
  );

  const d = details;
  const title = d?.title ?? pr.title;
  const url = d?.url ?? pr.url;
  const merge = d ? mergeStatus(d) : null;
  const checkCounts = d
    ? (["fail", "pending", "pass", "skipped"] as CheckState[])
        .map((s) => ({ s, n: d.checks.filter((c) => c.state === s).length }))
        .filter((c) => c.n > 0)
    : [];
  const overall = d ? summarizeChecks(d.checks.map((c) => c.state)) : pr.checks;
  /** Props that make a section foldable. */
  const fold = (section: PrSection) => ({
    collapsed: collapsed.includes(section),
    onToggle: onToggleSection ? () => onToggleSection(section) : undefined,
  });
  const decision =
    d?.reviewDecision === "approved"
      ? reviewerLook("approved", theme)
      : d?.reviewDecision === "changes-requested"
        ? reviewerLook("changes-requested", theme)
        : d?.reviewDecision === "review-required"
          ? reviewerLook("requested", theme)
          : null;

  return (
    <box ref={rootRef} width={width} flexShrink={0} flexDirection="row" backgroundColor={theme.panel}>
      {/* Left edge: drag to resize. The panel is flush right, so its width is
          the distance from the dragged-to column to the right edge. */}
      <ResizeHandle
        onDrag={(screenX) => {
          const el = rootRef.current;
          if (!el) return;
          onResize(el.screenX + el.width - screenX);
        }}
        onDragEnd={onResizeEnd}
        onReset={onResetWidth}
      />
      <box flexDirection="column" flexGrow={1} minWidth={0} paddingLeft={1} paddingRight={1}>
        {/* The PR's header, ruled off from the sections below. */}
        <box flexDirection="column" flexShrink={0} border={["bottom"]} borderColor={theme.border} marginBottom={1}>
          {/* number + state ................ checks overall, close */}
          <box flexDirection="row" flexShrink={0} paddingTop={1}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD} flexShrink={0}>
              {`⇡#${pr.number} `}
            </text>
            {d && (
              <text
                fg={toneColor(
                  d.state === "merged"
                    ? "merged"
                    : d.state === "closed"
                      ? "bad"
                      : d.state === "draft"
                        ? "muted"
                        : "good",
                  theme,
                )}
                flexShrink={0}
              >
                {STATE_LABEL[d.state]}
              </text>
            )}
            <box flexGrow={1} />
            {overall && (
              <text fg={checkLook(overall, theme).color} flexShrink={0}>
                {checkLook(overall, theme).glyph + " "}
              </text>
            )}
            <text fg={theme.fgMuted} flexShrink={0} onMouseDown={onClose}>
              {" ✕"}
            </text>
          </box>
          <text fg={theme.fg} attributes={TextAttributes.BOLD} flexShrink={0} onMouseDown={() => openExternal(url)}>
            {title}
          </text>
          {d && (
            <text fg={theme.fgMuted} flexShrink={0} wrapMode="none" truncate>
              {`${d.author || "?"} · ${d.base} ← ${d.head}`}
            </text>
          )}
          {d && (
            <text flexShrink={0} wrapMode="none" truncate>
              <span fg={theme.added}>{`+${d.additions}`}</span>
              <span fg={theme.removed}>{` −${d.deletions}`}</span>
              <span fg={theme.fgMuted}>{` · ${d.changedFiles} file${d.changedFiles === 1 ? "" : "s"}`}</span>
            </text>
          )}
        </box>

        {!d && (
          <box flexDirection="column" flexGrow={1} marginTop={1}>
            {error ? (
              <>
                <text fg={theme.removed}>{`Couldn't load PR #${pr.number}`}</text>
                <text fg={theme.fgFaint}>{error}</text>
                <text fg={theme.fgFaint} attributes={TextAttributes.DIM}>
                  {"r to retry"}
                </text>
              </>
            ) : (
              <text fg={theme.fgMuted}>{`Loading PR #${pr.number}…`}</text>
            )}
          </box>
        )}

        {d && merge && (
          <scrollbox
            ref={scrollRef}
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            scrollY
            contentOptions={{ paddingRight: 1 }}
          >
            <Section
              title="Merge"
              {...fold("merge")}
              folded={
                <text fg={toneColor(merge.tone, theme)} wrapMode="none" truncate>
                  {"  " + merge.label}
                </text>
              }
            >
              <Row glyph="●" color={toneColor(merge.tone, theme)} text={merge.label} />
              {d.state === "open" && onMerge && (
                // A filled button, so it reads as something to press.
                <box flexDirection="row" flexShrink={0}>
                  <text fg={theme.panel} bg={theme.accent} flexShrink={0} onMouseDown={onMerge}>
                    {" Merge… "}
                  </text>
                  <text fg={theme.fgFaint} flexShrink={0}>
                    {" m"}
                  </text>
                </box>
              )}
              {d.state === "merged" && onCloseWorktree && (
                // Done with it: the worktree can go (it asks first).
                <box flexDirection="row" flexShrink={0}>
                  <text fg={theme.panel} bg={theme.accent} flexShrink={0} onMouseDown={onCloseWorktree}>
                    {" Close worktree… "}
                  </text>
                  {closeKey && (
                    <text fg={theme.fgFaint} flexShrink={0}>
                      {` ${closeKey}`}
                    </text>
                  )}
                </box>
              )}
            </Section>

            <Section
              title="Reviews"
              {...fold("reviews")}
              extra={decision && <text fg={decision.color}>{"  " + decision.glyph}</text>}
            >
              {d.reviewers.length === 0 ? (
                <text fg={theme.fgFaint}>{"No reviews yet"}</text>
              ) : (
                d.reviewers.map((r) => {
                  const look = reviewerLook(r.state, theme);
                  return <Row key={r.login} glyph={look.glyph} color={look.color} text={r.login} />;
                })
              )}
            </Section>

            <Section
              title="Checks"
              {...fold("checks")}
              extra={
                checkCounts.length > 0 && (
                  <text flexShrink={0}>
                    {checkCounts.map(({ s, n }) => (
                      <span key={s} fg={checkLook(s, theme).color}>
                        {`  ${checkLook(s, theme).glyph} ${n}`}
                      </span>
                    ))}
                  </text>
                )
              }
            >
              {d.checks.length === 0 ? (
                <text fg={theme.fgFaint}>{"No checks"}</text>
              ) : (
                d.checks.map((c, i) => {
                  const look = checkLook(c.state, theme);
                  return (
                    <Row
                      // biome-ignore lint/suspicious/noArrayIndexKey: two checks can share a name (matrix jobs); the list is rebuilt from each fetch
                      key={`${c.name}-${i}`}
                      glyph={look.glyph}
                      color={look.color}
                      text={c.name}
                      dim={c.workflow && c.workflow !== c.name ? c.workflow : undefined}
                      onClick={c.url ? () => openExternal(c.url!) : undefined}
                    />
                  );
                })
              )}
            </Section>

            {d.labels.length > 0 && (
              <Section
                title="Labels"
                {...fold("labels")}
                folded={
                  <text fg={theme.fgFaint} wrapMode="none" truncate>
                    {"  " + d.labels.join(" · ")}
                  </text>
                }
              >
                <text fg={theme.fgMuted}>{d.labels.join(" · ")}</text>
              </Section>
            )}

            {d.body.trim() && (
              <Section title="Description" {...fold("description")}>
                <Quote>{excerpt(d.body, 6, 400)}</Quote>
              </Section>
            )}

            <Section
              title="Comments"
              {...fold("comments")}
              extra={d.comments.length > 0 && <text fg={theme.fgFaint}>{`  ${d.comments.length}`}</text>}
            >
              {d.comments.length === 0 ? (
                <text fg={theme.fgFaint}>{"No comments"}</text>
              ) : (
                d.comments.slice(0, MAX_COMMENTS).map((c, i) => (
                  <box
                    // biome-ignore lint/suspicious/noArrayIndexKey: comments have no id here; the list is rebuilt from each fetch
                    key={i}
                    flexDirection="column"
                    flexShrink={0}
                    marginBottom={1}
                    onMouseDown={() => openExternal(c.url ?? url)}
                  >
                    <text flexShrink={0} wrapMode="none" truncate>
                      <span fg={theme.fg}>{c.author}</span>
                      {c.kind === "inline" && c.path && (
                        <span fg={theme.accent}>{` ${c.path}${c.line ? ":" + c.line : ""}`}</span>
                      )}
                      {c.kind === "review" && c.reviewState && (
                        <span fg={reviewerLook(c.reviewState, theme).color}>
                          {` ${reviewerLook(c.reviewState, theme).label}`}
                        </span>
                      )}
                      <span fg={theme.fgFaint}>{` · ${relativeTime(c.createdAt)}`}</span>
                    </text>
                    <Quote>{excerpt(c.body)}</Quote>
                  </box>
                ))
              )}
              {d.comments.length > MAX_COMMENTS && (
                <text fg={theme.fgFaint}>{`…${d.comments.length - MAX_COMMENTS} more — o to open on GitHub`}</text>
              )}
            </Section>
          </scrollbox>
        )}

        {/* Footer */}
        <box flexShrink={0} border={["top"]} borderColor={theme.border}>
          <Hints
            hints={[
              {
                // How fresh this is (r refreshes).
                text: query.isFetching
                  ? "↻ refreshing…"
                  : error && details
                    ? "↻ failed"
                    : query.dataUpdatedAt
                      ? `↻ ${relativeTime(new Date(query.dataUpdatedAt).toISOString())}`
                      : "",
              },
              ...(d?.state === "open" ? [{ key: "m", text: "merge" }] : []),
              { key: "o", text: "open" },
            ].filter((h) => h.text)}
          />
        </box>
      </box>
    </box>
  );
}
