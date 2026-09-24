/** Quoting for POSIX shell command lines (tmux runs window commands with `sh -c`; ssh hands its command to a shell). */

/** Quote one argument for a POSIX shell. Simple words stay as they are, for readable logs. */
export function shq(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A shell command line from an argv, every argument quoted. */
export function shellJoin(argv: string[]): string {
  return argv.map(shq).join(" ");
}
