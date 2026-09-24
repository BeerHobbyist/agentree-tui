/**
 * How the terminals agentree opens can run agentree's CLI: a launcher script
 * next to state.json, which their sessions put on PATH (and name in
 * $AGENTREE_CLI) — the compiled binary, or `bun src/index.tsx` in development.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateFilePath } from "../config";
import { shq } from "./shell";

/** The directory the launcher lives in (put on the sessions' PATH). */
export function cliBinDir(): string {
  return join(dirname(stateFilePath()), "bin");
}

/** The launcher script's content for this agentree. */
export function cliLauncherScript(execPath = process.execPath): string {
  // Running under bun (development, tests): the entry point is a source file.
  const dev = basename(execPath).startsWith("bun");
  const entry = fileURLToPath(new URL("../index.tsx", import.meta.url));
  return `#!/bin/sh\n# agentree's CLI, for the terminals it opens (written by agentree).\nexec ${shq(execPath)}${dev ? " " + shq(entry) : ""} "$@"\n`;
}

/**
 * Make `agentree` runnable in the terminals agentree opens: write the launcher,
 * and put its directory on agentree's own PATH. That has to be agentree's own:
 * tmux gives a new window the PATH of the client that creates it — agentree's
 * tmux clients, for the first window and ⌥t — not the session's `-e PATH`.
 * Returns the launcher's path.
 */
export function ensureCliOnPath(): string {
  const launcher = ensureCliLauncher();
  const dir = cliBinDir();
  const path = process.env.PATH ?? "";
  if (!path.split(":").includes(dir)) process.env.PATH = path ? `${dir}:${path}` : dir;
  return launcher;
}

/** Write the launcher if it's missing or stale; returns its path. */
export function ensureCliLauncher(): string {
  const path = join(cliBinDir(), "agentree");
  const content = cliLauncherScript();
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // missing
  }
  if (current !== content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + ".tmp", content, { mode: 0o755 });
    chmodSync(path + ".tmp", 0o755);
    renameSync(path + ".tmp", path);
  }
  return path;
}
