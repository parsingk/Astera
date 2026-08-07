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
    // Deletes the fs.mkdtemp fixtures the suite leaves in os.tmpdir() — see the file for why this is
    // a single run-level teardown rather than an afterEach in each test file.
    globalSetup: ['./vitest.globalSetup.ts']
  }
})
