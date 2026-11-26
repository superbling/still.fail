// A git command past its deadline ended whole, on real processes and signals, so it runs beside the checks
// (`pnpm test:side`): `git gc` starts `repack` and `pack-objects`, which a kill of git alone leaves running.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { wall } from "../src/ops/fibers.ts";
import { runRepoGit } from "../src/ops/repo-branches.ts";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("git past its deadline is ended with what it started, and its end is heard", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "repo-git-deadline-"));
  const changes = watch(dir);
  try {
    execFileSync("git", ["init", "-q", dir]);
    const pidFile = join(dir, "child.pid");
    // The child holds Git's stdout. Removing its script also releases it if the test fails.
    writeFileSync(join(dir, "child.cjs"), `const fs = require("node:fs");
const hold = fs.watch(__filename, () => hold.close());
fs.writeFileSync("child.tmp", String(process.pid));
fs.renameSync("child.tmp", "child.pid");
`);
    // Hold the git deadline until its grandchild holds stdout. The signal, the grace period, and both processes are real.
    let expire: (() => void) | undefined;
    t.mock.method(wall, "after", (ms: number, fire: () => void) => {
      assert.equal(ms, 300);
      expire = fire;
      return () => { expire = undefined; };
    }, { times: 1 });
    // Git can forward a signal to its alias shell. The shell waits for a separate child that inherits stdout.
    const alias = 'alias.slow=!f() { "$@" & wait "$!"; }; f';
    const ended = runRepoGit(dir, ["-c", alias, "slow", process.execPath, "child.cjs"], 300, true);
    let pid: number;
    try {
      const readyBy = AbortSignal.timeout(5_000);
      while (!existsSync(pidFile)) await once(changes, "change", { signal: readyBy });
      pid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(Number.isSafeInteger(pid) && pid > 1 && alive(pid), "git's grandchild is running");
      assert.ok(expire, "git armed its deadline");
    } finally {
      expire?.();
    }
    const result = await wall.within(5_000, ended, "git did not close after its deadline");
    assert.equal(result.ok, false);
    // A reparented grandchild can take a moment to be reaped.
    const until = Date.now() + 5_000;
    while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid), false, "the grandchild ended with git");
  } finally {
    changes.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
