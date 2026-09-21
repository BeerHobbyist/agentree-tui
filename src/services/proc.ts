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
}

/** Run a command, capturing stdout/stderr. Never throws on non-zero exit. */
export async function run(
  cmd: string[],
  opts: RunOptions = {},
): Promise<ProcResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, stdout, stderr };
}

/** Run a command, returning stdout; throws with stderr on non-zero exit. */
export async function runOrThrow(
  cmd: string[],
  opts: RunOptions = {},
): Promise<string> {
  const { code, stdout, stderr } = await run(cmd, opts);
  if (code !== 0) {
    throw new Error(
      (stderr || stdout || `command failed: ${cmd.join(" ")}`).trim(),
    );
  }
  return stdout;
}
