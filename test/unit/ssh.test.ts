/** Quoting and argv building for SSH projects. */
import { describe, expect, test } from "bun:test";
import {
  displayPath,
  isValidHost,
  parseSshConfigHosts,
  remoteArgv,
  remotePathExpr,
  shellJoin,
  shq,
} from "../../src/services/ssh";
import { attachCommand } from "../../src/services/tmux";

/** What a POSIX shell makes of a command line: each argument on its own line. */
function throughShell(line: string, env: Record<string, string> = {}): string[] {
  const out = Bun.spawnSync(["sh", "-c", `set -- ${line}; for a in "$@"; do printf '%s\\n' "$a"; done`], {
    env: { ...process.env, ...env },
  });
  return new TextDecoder().decode(out.stdout).split("\n").slice(0, -1);
}

describe("shq / shellJoin", () => {
  test("every argument survives the remote shell as-is", () => {
    const args = ["plain", "two words", "it's", ";", "$HOME", "`id`", "a\"b", "", "#{window_name}\t#{pane_id}"];
    expect(throughShell(shellJoin(args))).toEqual(args);
  });

  test("simple words stay unquoted, for readable logs", () => {
    expect(shq("new-session")).toBe("new-session");
    expect(shq("/srv/app")).toBe("/srv/app");
    expect(shq("a b")).toBe("'a b'");
  });
});

describe("remotePathExpr", () => {
  test("~ expands to the remote home; the rest is quoted", () => {
    const env = { HOME: "/home/dev" };
    expect(throughShell(remotePathExpr("~"), env)).toEqual(["/home/dev"]);
    expect(throughShell(remotePathExpr("~/my code/api"), env)).toEqual(["/home/dev/my code/api"]);
    expect(throughShell(remotePathExpr("/srv/$app"), env)).toEqual(["/srv/$app"]);
  });
});

describe("displayPath", () => {
  test("paths under the remote home show as ~", () => {
    expect(displayPath("/home/dev", "/home/dev")).toBe("~");
    expect(displayPath("/home/dev/code/api", "/home/dev")).toBe("~/code/api");
    expect(displayPath("/home/developer", "/home/dev")).toBe("/home/developer");
    expect(displayPath("/srv/app", "/home/dev")).toBe("/srv/app");
    expect(displayPath("/srv/app")).toBe("/srv/app");
  });
});

describe("isValidHost", () => {
  test("aliases, user@host and ssh:// URLs; never an option or blank", () => {
    for (const ok of ["dev-box", "me@10.0.0.2", "ssh://me@host:2222"]) expect(isValidHost(ok)).toBe(true);
    for (const bad of ["", "-oProxyCommand=x", "two words", " dev"]) expect(isValidHost(bad)).toBe(false);
  });
});

describe("parseSshConfigHosts", () => {
  test("Host names, skipping patterns and comments", () => {
    const config = [
      "Host dev-box",
      "  HostName 10.0.0.2",
      "Host staging prod # two at once",
      "Host *",
      "  ServerAliveInterval 30",
      "host *.internal !bastion",
      "# Host commented-out",
      "Host dev-box",
    ].join("\n");
    expect(parseSshConfigHosts(config)).toEqual(["dev-box", "staging", "prod"]);
  });
});

describe("remoteArgv", () => {
  test("background calls: batch mode, one shared connection per host, host after --", () => {
    const argv = remoteArgv("dev-box", ["tmux", "list-windows"]);
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("ControlMaster=auto");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("-T");
    expect(argv.slice(-3)).toEqual(["--", "dev-box", "exec sh -c 'tmux list-windows'"]);
  });

  test("an interactive terminal gets a tty and may prompt", () => {
    const argv = remoteArgv("dev-box", ["tmux"], { tty: true });
    expect(argv).toContain("-t");
    expect(argv).not.toContain("BatchMode=yes");
  });
});

describe("attachCommand on a host", () => {
  test("runs the same tmux command list over ssh -t, separators intact", () => {
    const local = attachCommand("s1", "/srv/app");
    const remote = attachCommand("s1", "/srv/app", undefined, undefined, {}, "dev-box");
    expect(remote.slice(0, 1)).toEqual(["ssh"]);
    expect(remote).toContain("-t");
    expect(remote.at(-2)).toBe("dev-box");
    // Whatever the login shell, `sh -c` runs the line, which hands tmux
    // exactly the local argv (`;` included).
    const [exec, sh, c, line] = throughShell(remote.at(-1)!);
    expect([exec, sh, c]).toEqual(["exec", "sh", "-c"]);
    // …plus -u: the ssh session may have no UTF-8 locale, and tmux would
    // print non-ASCII (and the tabs in list formats) as "_".
    expect(throughShell(line!)).toEqual(["tmux", "-u", ...local.slice(1)]);
  });
});
