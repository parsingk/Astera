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
// Only directories whose name starts with PREFIX AND that were created after this run began are
// removed, so a concurrent test run or an unrelated program's temp directory is left alone.
//
// Every fixture prefix in the suite starts with this one string, which is what keeps the rule to a
// single entry. That is worth preserving: an earlier version listed a dozen prefixes including bare
// `cs-` and `rt-`, and a two-character prefix is short enough to collide with another program's
// temporary directory. If you add a fixture, name it `astera-<something>-`.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PREFIX = 'astera-'

export default async function setup(): Promise<() => Promise<void>> {
  // A second of slack absorbs filesystem timestamp granularity — without it a fixture created in the
  // same tick the run starts can be judged "older than the run" and survive.
  const startedAt = Date.now() - 1_000
  const tmp = os.tmpdir()

  return async () => {
    let entries: string[]
    try {
      entries = await fs.readdir(tmp)
    } catch {
      return // an unreadable temp directory is not worth failing the run over
    }
    let removed = 0
    for (const name of entries) {
      if (!name.startsWith(PREFIX)) continue
      const full = path.join(tmp, name)
      try {
        const st = await fs.stat(full)
        if (!st.isDirectory() || st.birthtimeMs < startedAt) continue
        // force also clears the read-only attribute git puts on its object files
        await fs.rm(full, { recursive: true, force: true })
        removed++
      } catch {
        // Still locked, already gone, or not ours to delete — the next run picks it up.
      }
    }
    if (removed > 0) console.log(`[globalSetup] removed ${removed} temp fixture directories`)
  }
}
