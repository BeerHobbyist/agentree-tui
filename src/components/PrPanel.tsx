import { useEffect, useRef, useState, type RefObject } from "react";
import { TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { useTheme, type Theme } from "../theme";
import type { CheckState, PrDetails, PrInfo, PrReviewer } from "../data/model";
import {
  excerpt,
  fetchPrDetails,
  mergeStatus,
  relativeTime,
  summarizeChecks,
  type Tone,
} from "../services/pr";
import { openExternal } from "../services/open";
import { ResizeHandle } from "./ResizeHandle";

/** How often an open panel re-fetches its PR. */
export const PR_REFRESH_MS = 30_000;
/** Comments shown before "…N more on GitHub". */
const MAX_COMMENTS = 20;

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

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} flexShrink={0}>
          {title}
        </text>
        {extra}
      </box>
      {children}
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
  handleRef,
}: PrPanelProps) {
  const theme = useTheme();
  const rootRef = useRef<BoxRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [details, setDetails] = useState<PrDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // Responses for a PR we've since switched away from are dropped.
  const requestId = useRef(0);

  const load = () => {
    const id = ++requestId.current;
    setLoading(true);
    fetchPrDetails(repo, pr.number)
      .then((d) => {
        if (id !== requestId.current) return;
        setDetails(d);
        setError(null);
        setFetchedAt(Date.now());
      })
      .catch((e: unknown) => {
        if (id !== requestId.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  };

  useEffect(() => {
    setDetails(null);
    setError(null);
    setFetchedAt(null);
    scrollRef.current?.scrollTo(0);
    load();
    const timer = setInterval(load, PR_REFRESH_MS);
    return () => {
      clearInterval(timer);
      requestId.current++; // abandon anything in flight
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, pr.number]);

  if (handleRef) {
    handleRef.current = {
      refresh: load,
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
  const decision =
    d?.reviewDecision === "approved"
      ? { label: "approved", color: theme.added }
      : d?.reviewDecision === "changes-requested"
        ? { label: "changes requested", color: theme.removed }
        : d?.reviewDecision === "review-required"
          ? { label: "review required", color: theme.dirty }
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
        {/* Header: number + state ................ checks overall, close */}
        <box flexDirection="row" flexShrink={0} paddingTop={1}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD} flexShrink={0}>
            {`⇡ #${pr.number} `}
          </text>
          {d && (
            <text
              fg={toneColor(
                d.state === "merged" ? "merged" : d.state === "closed" ? "bad" : d.state === "draft" ? "muted" : "good",
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
          <text flexShrink={0} wrapMode="none" truncate marginBottom={1}>
            <span fg={theme.added}>{`+${d.additions}`}</span>
            <span fg={theme.removed}>{` −${d.deletions}`}</span>
            <span fg={theme.fgMuted}>{` · ${d.changedFiles} file${d.changedFiles === 1 ? "" : "s"} · updated ${relativeTime(d.updatedAt)}`}</span>
          </text>
        )}

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
            <Section title="Merge">
              <Row glyph="●" color={toneColor(merge.tone, theme)} text={merge.label} />
            </Section>

            <Section
              title="Reviews"
              extra={decision && <text fg={decision.color}>{"  " + decision.label}</text>}
            >
              {d.reviewers.length === 0 ? (
                <text fg={theme.fgFaint}>{"No reviews yet"}</text>
              ) : (
                d.reviewers.map((r) => {
                  const look = reviewerLook(r.state, theme);
                  return <Row key={r.login} glyph={look.glyph} color={look.color} text={r.login} dim={look.label} />;
                })
              )}
            </Section>

            <Section
              title="Checks"
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
              <Section title="Labels">
                <text fg={theme.fgMuted}>{d.labels.join(" · ")}</text>
              </Section>
            )}

            {d.body.trim() && (
              <Section title="Description">
                <text fg={theme.fgMuted}>{excerpt(d.body, 6, 400)}</text>
              </Section>
            )}

            <Section
              title="Comments"
              extra={d.comments.length > 0 && <text fg={theme.fgFaint}>{`  ${d.comments.length} · newest first`}</text>}
            >
              {d.comments.length === 0 ? (
                <text fg={theme.fgFaint}>{"No comments"}</text>
              ) : (
                d.comments.slice(0, MAX_COMMENTS).map((c, i) => (
                  <box
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
                    <text fg={theme.fgMuted} flexShrink={0}>
                      {excerpt(c.body)}
                    </text>
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
        <text fg={theme.fgFaint} attributes={TextAttributes.DIM} flexShrink={0} wrapMode="none" truncate>
          {(loading ? "refreshing…" : fetchedAt ? `updated ${relativeTime(new Date(fetchedAt).toISOString())}` : "") +
            " · o open · r refresh"}
        </text>
      </box>
    </box>
  );
}
