import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import os from 'node:os'
import { workersFor } from './vitest.workers'
import { enforceHookPlugin } from './electron.vite.enforceHook'

export default defineConfig({
  // The vendored shadcn and assistant-ui components (src/renderer/src/components/ui/,
  // components/assistant-ui/elements/) import each other through the `@` alias. electron.vite.config.ts
  // resolves it for the real app; without the same alias here, a test importing one of those
  // components — directly, or transitively through a house component that reuses one — fails to
  // resolve the module at all, before any test in it even runs. Written the same way
  // electron.vite.config.ts does it (fileURLToPath + import.meta.url, not path.resolve(__dirname, ...))
  // so the two cannot quietly drift to resolving `@` to two different folders.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url))
    }
  },
  // Enforce's hook as the build bundles it, so a test runs the very file the sessions run (electron.vite.enforceHook.ts)
  plugins: [enforceHookPlugin()],
  test: {
    include: [
      'src/core/**/*.test.ts',
      'src/host/**/*.test.ts',
      'src/main/**/*.test.ts',
      'src/renderer/**/*.test.ts',
      'src/cli/**/*.test.ts',
      'src/pluginHost/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'examples/**/*.test.ts',
      'scripts/**/*.test.mjs',
      'vitest.globalSetup.test.ts',
      'vitest.config.test.ts',
      'electron.vite.warnings.test.ts'
    ],
    environment: 'node',
    // 30 s, not 10: a test that spawns git, node or PowerShell takes up to 5 s alone here (integrateGit's merges: 4.6 s)
    // and two to three times that under the full suite, so 10 s failed tests that were only slow (load-sensitive
    // tests, 2026-10-14). A test that really hangs still fails, 20 s later.
    testTimeout: 30_000,
    // vitest's own cores - 1 up to 3 workers, half the cores above that: see vitest.workers.ts for the measurements.
    maxWorkers: workersFor(os.availableParallelism()),
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
