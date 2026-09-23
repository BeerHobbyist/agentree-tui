/**
 * Per-test sandbox: a temp workspace + config dir, an isolated git and tmux
 * environment, and the fake `gh` on PATH.
 *
 * Every test that touches the store, git, gh or tmux must go through this —
 * without it the suite would read and write the developer's real
 * `~/.config/agentree/state.json`, `~/agentree`, and tmux sessions.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RepoSummary } from "../../src/data/model";
import type { State } from "../../src/store";
import { clearPrCache, clearRepoCache } from "../../src/services/gh";
import { resetTheme } from "../../src/theme";

const FAKEBIN = join(import.meta.dir, "fakebin");

/** A repo as the fake `gh api user/repos` should report it. */
export interface FakeRepo {
  nameWithOwner: string;
  description?: string;
  isPrivate?: boolean;
  pushedAt?: string;
}

/** A pull request as the fake `gh pr list` should report it. */
export interface FakePr {
  number: number;
  title: string;
  headRefName: string;
  url?: string;
  isDraft?: boolean;
}

export interface Sandbox {
  /** Temp root holding everything this test created. */
  root: string;
  /** AGENTREE_HOME — where repos are cloned and worktrees created. */
  workspace: string;
  /** XDG_CONFIG_HOME — state.json lives under here. */
  configHome: string;
  /** Fixture "GitHub": the repos the fake `gh repo clone` clones from. */
  remotes: string;
  /** tmux socket name for this test (never the shared `agentree` one). */
  tmuxSocket: string;
  /** Absolute path of the persisted state file. */
  stateFile: string;
  /** Parsed state.json, or null when the app has not written one yet. */
  readState(): State | null;
  /** Publish a page of repos for the fake `gh api user/repos`. */
  setRepoPage(page: number, repos: FakeRepo[]): void;
  /** Publish the repo's open PRs, as the add-worktree picker lists them. */
  setOpenPrs(prs: FakePr[]): void;
  /** Publish the PR the sidebar's per-branch badge lookup should find. */
  setBranchPr(pr: FakePr | null): void;
  /** Make the fake `gh` fail for these subcommands (api, clone, pr, auth). */
  failGh(...subcommands: string[]): void;
  /** Every `gh` invocation so far, one argv string per line. */
  ghCalls(): string[];
  cleanup(): void;
}

function toApiPr(pr: FakePr) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url ?? `https://github.com/acme/widget/pull/${pr.number}`,
    isDraft: pr.isDraft ?? false,
    headRefName: pr.headRefName,
  };
}

function toApiRepo(r: FakeRepo) {
  const [, name = r.nameWithOwner] = r.nameWithOwner.split("/");
  return {
    name,
    full_name: r.nameWithOwner,
    description: r.description ?? "",
    private: r.isPrivate ?? false,
    pushed_at: r.pushedAt ?? "2026-01-01T00:00:00Z",
    updated_at: r.pushedAt ?? "2026-01-01T00:00:00Z",
    html_url: `https://github.com/${r.nameWithOwner}`,
  };
}

/** Repo summaries in the shape the UI receives them, for unit tests. */
export function repoSummary(nameWithOwner: string, extra: Partial<RepoSummary> = {}): RepoSummary {
  const [, name = nameWithOwner] = nameWithOwner.split("/");
  return {
    name,
    nameWithOwner,
    description: "",
    isPrivate: false,
    updatedAt: "2026-01-01T00:00:00Z",
    url: `https://github.com/${nameWithOwner}`,
    ...extra,
  };
}

export function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "agentree-test-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const remotes = join(root, "remotes");
  const fixtures = join(root, "gh-fixtures");
  const ghLog = join(root, "gh.log");
  const gitconfig = join(root, "gitconfig");
  for (const d of [workspace, configHome, remotes, fixtures]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(ghLog, "");
  writeFileSync(gitconfig, "");

  const tmuxSocket = `agentree-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  /**
   * Stop this test's own tmux server (a unique socket — never the shared
   * `agentree` one), if it started one, and remove the socket file tmux leaves
   * behind after kill-server.
   */
  const stopTmux = () => {
    Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    const uid = process.getuid?.() ?? 0;
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`, tmuxSocket), { force: true });
  };
  const saved = { ...process.env };

  Object.assign(process.env, {
    AGENTREE_HOME: workspace,
    XDG_CONFIG_HOME: configHome,
    AGENTREE_TMUX_SOCKET: tmuxSocket,
    // A terminal opened in a test (adding a worktree opens it) would otherwise
    // start the real `claude` on the developer's machine.
    AGENTREE_AGENT_CMD: "sh",
    PATH: `${FAKEBIN}:${process.env.PATH ?? ""}`,
    FAKE_GH_DIR: fixtures,
    FAKE_GH_REMOTES: remotes,
    FAKE_GH_LOG: ghLog,
    FAKE_GH_FAIL: "",
    // Keep git away from the developer's identity and global config.
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_AUTHOR_NAME: "agentree test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "agentree test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  });

  // Module-level caches and the theme store are global; a leak between tests
  // shows up as an unrelated test seeing the previous one's repos.
  clearRepoCache();
  clearPrCache();
  resetTheme();

  const stateFile = join(configHome, "agentree", "state.json");

  return {
    root,
    workspace,
    configHome,
    remotes,
    tmuxSocket,
    stateFile,
    readState() {
      try {
        return JSON.parse(readFileSync(stateFile, "utf8")) as State;
      } catch {
        return null;
      }
    },
    setOpenPrs(prs) {
      writeFileSync(join(fixtures, "open-prs.json"), JSON.stringify(prs.map(toApiPr)));
    },
    setBranchPr(pr) {
      writeFileSync(join(fixtures, "prs.json"), JSON.stringify(pr ? [toApiPr(pr)] : []));
    },
    setRepoPage(page, repos) {
      const file = join(fixtures, `repos-page-${page}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(repos.map(toApiRepo)));
    },
    failGh(...subcommands) {
      process.env.FAKE_GH_FAIL = subcommands.join(",");
    },
    ghCalls() {
      try {
        return readFileSync(ghLog, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    cleanup() {
      stopTmux();
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
      // Again, for a terminal's tmux client that connected only after the first
      // stop and so started a fresh server.
      stopTmux();
    },
  };
}
