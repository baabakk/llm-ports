/**
 * Async generator that walks a directory tree, yielding files whose extension
 * matches one of `extensions`. Skips node_modules, .git, dist, build dirs.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage"]);

export async function* walk(root: string, extensions: string[]): AsyncGenerator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        for (const ext of extensions) {
          if (entry.name.endsWith(ext)) {
            yield full;
            break;
          }
        }
      }
    }
  }
}
