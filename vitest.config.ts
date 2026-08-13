import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/core/**/*.test.ts',
      'src/main/**/*.test.ts',
      'src/renderer/**/*.test.ts',
      'src/cli/**/*.test.ts'
    ],
    environment: 'node',
    testTimeout: 10_000,
    // Hooks get their own, longer budget. The worktree fixtures build a real git repository in
    // beforeEach — mkdtemp, then five `git` processes — and on a loaded CI runner that overran the
    // 10s a hook otherwise inherits from testTimeout, failing two files with "Hook timed out" rather
    // than anything about the code. Process spawn time scales with the machine, so the number has to
    // leave room for the worst runner, not the developer's.
    hookTimeout: 60_000,
    // Deletes the fs.mkdtemp fixtures the suite leaves in os.tmpdir() — see the file for why this is
    // a single run-level teardown rather than an afterEach in each test file.
    globalSetup: ['./vitest.globalSetup.ts']
  }
})
