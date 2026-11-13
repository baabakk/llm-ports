/**
 * A fake CLI binary that subprocess adapters can be pointed at.
 *
 * Lives here rather than in one adapter's tests because both subprocess
 * adapters need it and a third is planned. It records what the adapter sent,
 * which for this family is argv plus stdin, and that recording is what the
 * suite's honoured-or-refused assertions read through
 * `inspectLastRunAgentRequest`.
 *
 * It does not write a launcher script. Node refuses to spawn a `.cmd` without a
 * shell and a shebang file is not executable on Windows at all, so the fake
 * runs on the current Node binary and the adapter's `cliArgsPrefix` carries the
 * script path. Needing that option is itself a finding: without it these
 * adapters can only be driven by a bare executable on PATH, which excludes
 * `npx`, any wrapper, and every test harness.
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the fake recorded from one invocation. */
export interface CapturedInvocation {
  argv: string[];
  stdin: string;
}

/** The response the next invocation should emit. */
export interface FakeCliResponse {
  text: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export interface FakeCli {
  /** Pass as the adapter's `cliPath`. */
  cliPath: string;
  /** Pass as the adapter's `cliArgsPrefix`. */
  cliArgsPrefix: readonly string[];
  /** Set what the next invocation emits, so the suite's mock setters work. */
  setResponse: (response: FakeCliResponse) => void;
  /** Read what the last invocation received. Throws if it never ran. */
  lastInvocation: () => CapturedInvocation;
  /** True once the fake has been invoked at least once. */
  ran: () => boolean;
}

/**
 * How the fake shapes its stdout.
 *
 * - `"jsonl"`: one JSON event per line, which is what a `--json` CLI emits.
 * - `"text"`: the response text on stdout, which is what a plain CLI emits.
 */
export type FakeCliMode = "jsonl" | "text";

function captureScript(capturePath: string, responsePath: string, mode: FakeCliMode): string {
  const target = JSON.stringify(capturePath);
  const response = JSON.stringify(responsePath);
  const emit =
    mode === "jsonl"
      ? 'process.stdout.write(JSON.stringify({ type: "item.completed", ...canned }) + "\\n");'
      : "process.stdout.write(String(canned.text ?? \"\"));";

  return `
import { writeFileSync, readFileSync, existsSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", emit);
// A closed or absent stdin never fires "end" on every platform, so do not wait
// on it indefinitely: these adapters pass their prompt in argv.
setTimeout(emit, 50);
let done = false;
function emit() {
  if (done) return;
  done = true;
  writeFileSync(${target}, JSON.stringify({ argv: process.argv.slice(2), stdin }), "utf8");
  const canned = existsSync(${response})
    ? JSON.parse(readFileSync(${response}, "utf8"))
    : { text: "ack", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  ${emit}
  process.exit(0);
}
`;
}

/**
 * Create the fake in a fresh temp directory.
 *
 * Each call gets its own directory, so two tests in one file cannot read each
 * other's capture. The contract suite calls `setup()` per test, which makes
 * that isolation load-bearing rather than tidy.
 */
export function makeFakeCli(mode: FakeCliMode = "jsonl"): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), "llmports-fakecli-"));
  const capturePath = join(dir, "capture.json");
  const responsePath = join(dir, "response.json");
  const scriptPath = join(dir, "capture.mjs");
  writeFileSync(scriptPath, captureScript(capturePath, responsePath, mode), "utf8");

  return {
    cliPath: process.execPath,
    cliArgsPrefix: [scriptPath],
    setResponse: (r) => writeFileSync(responsePath, JSON.stringify(r), "utf8"),
    ran: () => existsSync(capturePath),
    lastInvocation: () => {
      if (!existsSync(capturePath)) {
        throw new Error("the fake CLI was never invoked, so there is nothing to inspect");
      }
      return JSON.parse(readFileSync(capturePath, "utf8")) as CapturedInvocation;
    },
  };
}

/**
 * Build a {@link RunAgentTransmission} from what a subprocess adapter sent.
 *
 * Reads the prompt argument, which is where this family of adapters puts
 * everything, and reports what is observably present rather than what the
 * adapter intended. If the role prompt never reached the prompt, there is
 * nothing here to find, which is exactly the failure worth catching.
 */
export function transmissionFromArgv(
  invocation: CapturedInvocation,
  toolNamesToLookFor: readonly string[],
): { instructions: string; toolNames: string[]; messageRoles: string[] } {
  const { argv, stdin } = invocation;
  // The prompt is the last positional argument for one adapter and the value
  // paired with a flag for the other, so scan the whole of argv plus stdin.
  const haystack = `${argv.join("\n")}\n${stdin}`;

  const messageRoles: string[] = [];
  for (const match of haystack.matchAll(/^\s*(user|assistant|system)\s*:/gim)) {
    messageRoles.push(match[1]!.toLowerCase());
  }

  const toolNames = toolNamesToLookFor.filter((n) => haystack.includes(n));

  return { instructions: haystack, toolNames, messageRoles };
}
