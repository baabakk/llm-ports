/**
 * A fake `codex` binary the contract suite can drive.
 *
 * The adapter spawns its CLI directly, with no shell, so a fixture has to be
 * something the platform can execute: a `.cmd` on Windows and a shell script
 * elsewhere. Both launchers do the same thing, which is run the capture script
 * below on the current Node binary and forward every argument.
 *
 * The capture script records what the adapter actually sent, which is the
 * whole point: the contract suite's honoured-or-refused assertions ask the
 * adapter to report its own outbound request, and for a subprocess adapter the
 * outbound request is argv plus stdin.
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the fake binary recorded from one invocation. */
export interface CapturedInvocation {
  argv: string[];
  stdin: string;
}

export interface FakeCli {
  /** Pass as `cliPath` to the adapter factory. */
  cliPath: string;
  /** Pass as `cliArgsPrefix`, so the fake runs on the current Node binary. */
  cliArgsPrefix: readonly string[];
  /** Read what the last invocation received. Throws if it never ran. */
  lastInvocation: () => CapturedInvocation;
  /** True once the fake has been invoked at least once. */
  ran: () => boolean;
  /** Set what the next invocation emits, so the suite's mock setters work. */
  setResponse: (r: { text: string; model?: string; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }) => void;
}

/**
 * The script the launcher runs. Captures argv and stdin, then emits one
 * codex-shaped JSON event so the adapter has something to parse.
 *
 * Written as a string rather than a committed file so the capture path can be
 * baked in, which avoids an environment variable the launcher would have to
 * forward on two platforms.
 */
function captureScript(capturePath: string, responsePath: string): string {
  const target = JSON.stringify(capturePath);
  const response = JSON.stringify(responsePath);
  return `
import { writeFileSync, readFileSync, existsSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", emit);
// A closed or absent stdin never fires "end" on every platform, so do not
// wait on it indefinitely: the adapter passes its prompt in argv today.
setTimeout(emit, 50);
let done = false;
function emit() {
  if (done) return;
  done = true;
  writeFileSync(${target}, JSON.stringify({ argv: process.argv.slice(2), stdin }), "utf8");
  const canned = existsSync(${response})
    ? JSON.parse(readFileSync(${response}, "utf8"))
    : {
        text: "ack",
        model: "fake-codex-model",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };
  process.stdout.write(JSON.stringify({ type: "item.completed", ...canned }) + "\\n");
  process.exit(0);
}
`;
}

/**
 * Create the fake binary in a fresh temp directory.
 *
 * Each call gets its own directory so two tests running in the same file
 * cannot read each other's capture.
 */
export function makeFakeCli(): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), "llmports-fakecli-"));
  const capturePath = join(dir, "capture.json");
  const scriptPath = join(dir, "capture.mjs");
  const responsePath = join(dir, "response.json");
  writeFileSync(scriptPath, captureScript(capturePath, responsePath), "utf8");

  // No launcher script: Node refuses to spawn a `.cmd` without a shell, and a
  // shebang file is not executable on Windows at all. The adapter's
  // `cliArgsPrefix` makes both unnecessary, because the fake can be run on the
  // current Node binary directly.
  return {
    cliPath: process.execPath,
    cliArgsPrefix: [scriptPath],
    ran: () => existsSync(capturePath),
    setResponse: (r) => writeFileSync(responsePath, JSON.stringify(r), "utf8"),
    lastInvocation: () => {
      if (!existsSync(capturePath)) {
        throw new Error("the fake CLI was never invoked, so there is nothing to inspect");
      }
      return JSON.parse(readFileSync(capturePath, "utf8")) as CapturedInvocation;
    },
  };
}
