/**
 * Shared subprocess helper around Bun.spawn. All gh/git shell-outs go through
 * this so error handling and output capture are consistent.
 */

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Child environment. Defaults to the live `process.env`. */
  env?: Record<string, string | undefined>;
  /** Text to feed the command on stdin. */
  stdin?: string;
  /** Kill the command after this long; it then fails like any other non-zero exit. */
  timeoutMs?: number;
  /** Start it in a session of its own, with no controlling terminal: nothing it runs can open /dev/tty. */
  detached?: boolean;
}

/** Run a command, capturing stdout/stderr. Never throws on non-zero exit. */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<ProcResult> {
  // Bun snapshots the environment at process start, so passing it explicitly
  // is what makes a `process.env.PATH` change (tests' fake binaries) take.
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs,
    detached: opts.detached,
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, stdout, stderr };
}

/** Run a command, returning stdout; throws with stderr on non-zero exit. */
export async function runOrThrow(cmd: string[], opts: RunOptions = {}): Promise<string> {
  const { code, stdout, stderr } = await run(cmd, opts);
  if (code !== 0) {
    throw new Error((stderr || stdout || `command failed: ${cmd.join(" ")}`).trim());
  }
  return stdout;
}
