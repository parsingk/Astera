// Removes the temporary directories the test suite creates.
//
// Many tests build fixtures with fs.mkdtemp under os.tmpdir() — git repos, config stores, transcript
// files — and none of them clean up afterwards. Left alone that accumulates: a measurement on the
// development machine found 133,452 leftover directories from about two weeks of runs.
//
// This is done here rather than with an afterEach in each test file for two reasons. It is one place
// instead of forty-two, and a per-test cleanup can fail: on Windows a git repository directory is
// often still held briefly by the process that just wrote it, and a throwing afterEach would turn a
// slow leak into a flaky suite. Running once at the end, ignoring every failure, cannot do that.
//
// **Only directories that are provably stale are removed: created more than STALE_MS before this run
// began.** Nothing in os.tmpdir() says which run made a folder, so age is the only proof available,
// and it has to be age relative to something no other run can be in the middle of using.
//
// The previous rule was the opposite — remove what was created *after* this run began — on the idea
// that those were this run's own fixtures. They were not only this run's. A second run started a few
// seconds later creates its fixtures after this run began too, and this run's teardown deleted them
// while that run was still using them: a git fixture lost its repository mid-test (`rev-parse HEAD`
// failed, readGitSummary returned null), a rollout fixture lost its file. The failures landed in
// whichever unrelated tests the other run happened to be in, which is why they looked like flakes, and
// agents running suites side by side made it happen often. The cost of the new rule is that a run's
// own fixtures wait for a later run to sweep them, so up to STALE_MS of them are left at any moment.
//
// Every fixture prefix in the suite starts with this one string, which is what keeps the rule to a
// single entry. That is worth preserving: an earlier version listed a dozen prefixes including bare
// `cs-` and `rt-`, and a two-character prefix is short enough to collide with another program's
// temporary directory. If you add a fixture, name it `astera-<something>-`.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PREFIX = 'astera-'

/** The app's own directory under the temp folder, not a fixture. On macOS and Linux a running Host
 *  listens on a socket inside `<tmp>/astera-host-<key>` (src/host/address.ts), and it lives as long as
 *  the Host does — hours, so the age rule alone would take it. */
const APP_PREFIX = 'astera-host-'

/** How old a fixture must be, measured back from this run's start, before it is proven unused. A
 *  fixture is in use only while the test file that made it runs; a whole suite takes about a minute
 *  and a hook is allowed 60 seconds (vitest.config.ts). An hour is far past any of those. */
export const STALE_MS = 60 * 60 * 1000

/** Removes every `astera-*` fixture directory in `tmp` created more than STALE_MS before `startedAt`,
 *  ignoring every failure. Returns how many were removed. */
export async function removeStaleFixtures(tmp: string, startedAt: number): Promise<number> {
  let entries: string[]
  try {
    entries = await fs.readdir(tmp)
  } catch {
    return 0 // an unreadable temp directory is not worth failing the run over
  }
  let removed = 0
  for (const name of entries) {
    if (!name.startsWith(PREFIX) || name.startsWith(APP_PREFIX)) continue
    const full = path.join(tmp, name)
    try {
      const st = await fs.stat(full)
      if (!st.isDirectory() || st.birthtimeMs >= startedAt - STALE_MS) continue
      // force also clears the read-only attribute git puts on its object files
      await fs.rm(full, { recursive: true, force: true })
      removed++
    } catch {
      // Still locked, already gone, or not ours to delete — the next run picks it up.
    }
  }
  return removed
}

export default async function setup(): Promise<() => Promise<void>> {
  const startedAt = Date.now()
  return async () => {
    const removed = await removeStaleFixtures(os.tmpdir(), startedAt)
    if (removed > 0) console.log(`[globalSetup] removed ${removed} stale temp fixture directories`)
  }
}
