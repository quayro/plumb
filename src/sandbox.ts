import { existsSync } from "node:fs";

// everything may be read; nothing may be written and no network may be reached
const PROFILE =
  '(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null"))';

const BWRAP = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];

// wraps an adapter command so it can read the checkout but cannot write a file or open a socket;
// a platform without a sandbox tool refuses the command, so the adapter is incomplete, never
// trusted.
// shortcut: the sandbox is the operating system's (sandbox-exec, bubblewrap); Windows has none
// here, so a sandboxed adapter cannot run there until a job-object runner is added.
export function sandboxed(
  command: readonly string[],
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (platform === "darwin" && exists("/usr/bin/sandbox-exec")) {
    return ["/usr/bin/sandbox-exec", "-p", PROFILE, ...command];
  }
  const bwrap = platform === "linux" ? BWRAP.find((path) => exists(path)) : undefined;
  if (bwrap) {
    return [
      bwrap,
      // the whole filesystem read-only, including a checkout under /tmp; a private /proc needs its
      // own process namespace
      ...["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc"],
      ...["--unshare-net", "--die-with-parent", "--new-session"],
      ...command,
    ];
  }
  throw new Error(
    `No sandbox is available on ${platform}; install bubblewrap, or review the adapter and remove its sandbox flag`,
  );
}
