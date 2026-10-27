// The measuring run (enforce and sandbox design §8, E4): it writes fake credentials into the home folder, so it runs only
// on a GitHub Actions runner, and the workflow asks for both runners, the pinned CLIs and nothing beyond reading.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from './measure-sandbox.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('measure-sandbox', () => {
  it('refuses to run outside GitHub Actions', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'astera-measure-home-'))
    try {
      await expect(main({ env: {}, home, root })).rejects.toThrow(/only on a GitHub Actions runner/)
      await expect(main({ env: { GITHUB_ACTIONS: 'false' }, home, root })).rejects.toThrow(/only on a GitHub Actions runner/)
      expect(readdirSync(home)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('asks the workflow for both runners, the pinned versions and no more than reading', () => {
    const yml = readFileSync(path.join(root, '.github/workflows/measure-sandbox.yml'), 'utf8')
    for (const want of [
      'macos-latest',
      'ubuntu-latest',
      '@openai/codex@0.160.0',
      '@anthropic-ai/sandbox-runtime@0.0.79',
      'contents: read',
      "branches: ['measure/**']",
      'bubblewrap',
      'socat',
      'ripgrep',
      'zsh',
      'kernel.apparmor_restrict_unprivileged_userns=0',
      'node scripts/measure/measure-sandbox.mjs',
      'GH_TOKEN: ${{ github.token }}'
    ])
      expect(yml, want).toContain(want)
    // Nothing that writes back to the repository
    expect(yml).not.toMatch(/contents: write|git push/)
  })
})
