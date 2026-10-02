/**
 * Per-test sandbox: a temp workspace + config dir, an isolated git and tmux
 * environment, and the fake `gh` on PATH.
 *
 * Every test that touches the store, git, gh or tmux must go through this —
 * without it the suite would read and write the developer's real
 * `~/.config/agentree/state.json`, `~/agentree`, and tmux sessions.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RepoSummary } from "../../src/data/model";
import type { State } from "../../src/store";
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
  /** Raw `statusCheckRollup` entries (the badge is coloured by them). */
  checks?: Record<string, unknown>[];
  /** Default OPEN. */
  state?: "OPEN" | "MERGED" | "CLOSED";
  /** Its head commit, the commit its merge made, and its commits — how a merged PR is tied to a branch. */
  headRefOid?: string;
  mergeCommit?: string;
  commits?: string[];
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
  /**
   * Publish the PR the sidebar's per-branch badge lookup should find — for
   * `branch` only when given, otherwise for every branch.
   */
  setBranchPr(pr: FakePr | FakePr[] | null, branch?: string): void;
  /** Publish what `gh pr view <number> --json …` returns (raw GitHub shape). */
  setPrView(number: number, pr: Record<string, unknown>): void;
  /** Publish a PR's inline review comments (raw REST shape). */
  setPrComments(number: number, comments: Record<string, unknown>[]): void;
  /** Publish what `gh api repos/<repo>` returns (merge settings; default `{}`). */
  setRepoSettings(settings: Record<string, unknown>): void;
  /** URLs the app asked to open in a browser. */
  openedUrls(): string[];
  /** Make the fake `gh` fail for these subcommands (api, clone, pr, auth, merge). */
  failGh(...subcommands: string[]): void;
  /** Every `gh` invocation so far, one argv string per line. */
  ghCalls(): string[];
  /** The fake ssh host's home directory (a directory in the sandbox). */
  sshHome: string;
  /** Every `ssh` invocation so far, one argv string per line. */
  sshCalls(): string[];
  /** Write the ~/.ssh/config agentree reads host suggestions from. */
  setSshConfig(text: string): void;
  /** Make ssh connections fail, or the host lack tmux. */
  failSsh(how: "connect" | "no-tmux"): void;
  /** Make the ssh host log in with this password (no key login). */
  requireSshPassword(password: string): void;
  /** Whether the fake has a shared connection open (a password login succeeded). */
  sshConnected(): boolean;
  /** Drop the shared connection, as if it expired. */
  dropSshConnection(): void;
  /** Login attempts on the password host (each one a failed login if refused). */
  sshLoginAttempts(): string[];
  /**
   * Make tmux missing on this machine (a Mac without it) while the fake ssh
   * host keeps it: a `tmux` first on PATH that fails unless run "on the host".
   */
  hideLocalTmux(): void;
  /** Claude's user settings file here (CLAUDE_CONFIG_DIR in the sandbox). */
  claudeSettings: string;
  /** Notifications shown so far, as "title | body". */
  notifications(): string[];
  cleanup(): void;
}

function toApiPr(pr: FakePr) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url ?? `https://github.com/acme/widget/pull/${pr.number}`,
    isDraft: pr.isDraft ?? false,
    headRefName: pr.headRefName,
    statusCheckRollup: pr.checks ?? [],
    state: pr.state ?? "OPEN",
    headRefOid: pr.headRefOid ?? "",
    mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
    commits: (pr.commits ?? []).map((oid) => ({ oid })),
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
  // The real path: on macOS the temp dir is behind a symlink (/var → /private/var)
  // and git, `pwd` and the like report the resolved one.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentree-test-")));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const remotes = join(root, "remotes");
  const fixtures = join(root, "gh-fixtures");
  const ghLog = join(root, "gh.log");
  const openLog = join(root, "open.log");
  const gitconfig = join(root, "gitconfig");
  const sshHome = join(root, "ssh-home");
  const sshLog = join(root, "ssh.log");
  const sshConfig = join(root, "ssh-config");
  const sshMaster = join(root, "ssh-master");
  const sshAttempts = join(root, "ssh-attempts.log");
  const claudeConfig = join(root, "claude-config");
  const notifyLog = join(root, "notify.log");
  for (const d of [workspace, configHome, remotes, fixtures, sshHome]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(ghLog, "");
  writeFileSync(sshLog, "");
  writeFileSync(gitconfig, "");

  const tmuxSocket = `agentree-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  /**
   * Stop this test's own tmux server (a unique socket — never the shared
   * `agentree` one), if it started one, and remove the socket file tmux leaves
   * behind after kill-server.
   */
  const stopTmux = () => {
    Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    // A server started just after its socket file was removed can't be reached
    // by kill-server any more; its command line still names this test's unique
    // socket, so match on that.
    Bun.spawnSync(["pkill", "-f", `tmux -L ${tmuxSocket} `], { stdout: "ignore", stderr: "ignore" });
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
    // Record browser opens instead of launching one.
    AGENTREE_OPEN_CMD: join(FAKEBIN, "fake-open"),
    FAKE_OPEN_LOG: openLog,
    // The fake `ssh`: every host is this machine, with this as its home;
    // ~/.ssh/config suggestions come from a sandbox file.
    FAKE_SSH_HOME: sshHome,
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_FAIL: "",
    FAKE_SSH_NO_TMUX: "",
    FAKE_SSH_PASSWORD: "",
    FAKE_SSH_MASTER: sshMaster,
    FAKE_SSH_ATTEMPTS: sshAttempts,
    AGENTREE_SSH_CONFIG: sshConfig,
    // Claude's user settings (tracking every claude edits them), and
    // notifications recorded instead of shown.
    CLAUDE_CONFIG_DIR: claudeConfig,
    AGENTREE_NOTIFY_CMD: join(FAKEBIN, "fake-notify"),
    AGENTREE_NOTIFY: "",
    FAKE_NOTIFY_LOG: notifyLog,
    // Diff viewers "installed": plain git only, whatever this machine has.
    AGENTREE_DIFF_VIEWERS: "git",
    // Status glyphs hold still, so frames are the same from one capture to the next.
    AGENTREE_ANIMATIONS: "off",
    // ssh's shared-connection sockets go here rather than the real runtime dir.
    XDG_RUNTIME_DIR: join(root, "run"),
    // Keep git away from the developer's identity and global config.
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_AUTHOR_NAME: "agentree test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "agentree test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  });
  // Run from inside fence or not, the CLI reaches tmux directly unless a test says otherwise.
  delete process.env.FENCE_SANDBOX;
  delete process.env.AGENTREE_SANDBOX_CMD;

  // Module-level caches and the theme store are global; a leak between tests
  // shows up as an unrelated test seeing the previous one's repos.
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
    setBranchPr(pr, branch) {
      const file = branch ? `prs-head-${branch.replace(/\//g, "_")}.json` : "prs.json";
      writeFileSync(join(fixtures, file), JSON.stringify((pr === null ? [] : [pr].flat()).map(toApiPr)));
    },
    setPrView(number, pr) {
      writeFileSync(join(fixtures, `pr-view-${number}.json`), JSON.stringify(pr));
    },
    setPrComments(number, comments) {
      writeFileSync(join(fixtures, `pr-comments-${number}.json`), JSON.stringify(comments));
    },
    setRepoSettings(settings) {
      writeFileSync(join(fixtures, "repo-settings.json"), JSON.stringify(settings));
    },
    openedUrls() {
      try {
        return readFileSync(openLog, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
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
    sshHome,
    sshCalls() {
      try {
        return readFileSync(sshLog, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    setSshConfig(text) {
      writeFileSync(sshConfig, text);
    },
    failSsh(how) {
      if (how === "connect") process.env.FAKE_SSH_FAIL = "1";
      else process.env.FAKE_SSH_NO_TMUX = "1";
    },
    requireSshPassword(password) {
      process.env.FAKE_SSH_PASSWORD = password;
    },
    sshConnected() {
      return existsSync(sshMaster);
    },
    dropSshConnection() {
      rmSync(sshMaster, { force: true });
    },
    claudeSettings: join(claudeConfig, "settings.json"),
    notifications() {
      try {
        return readFileSync(notifyLog, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    hideLocalTmux() {
      const real = Bun.which("tmux");
      if (!real) throw new Error("hideLocalTmux: no tmux to hide");
      const dir = join(root, "no-tmux-bin");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "tmux"),
        `#!/bin/sh\n[ -n "$FAKE_SSH_REMOTE" ] && exec ${real} "$@"\necho "tmux: command not found" >&2\nexit 127\n`,
        { mode: 0o755 },
      );
      process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
    },
    sshLoginAttempts() {
      try {
        return readFileSync(sshAttempts, "utf8").split("\n").filter(Boolean);
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
