// The release body (docs/releasing.md): its range and its compare link start at the app release before this one. A
// package's tag (client-v…, plugin-sdk-v…) can sit on the same commit as that release, as client-v0.3.0 and
// plugin-sdk-v0.2.0 sit on v1.4.14's, and must not be taken for it: v1.4.15's dry run linked client-v0.3.0...v1.4.15.
import { describe, it, expect, afterEach } from 'vitest'
import { removeFixture } from '../src/core/testFixtures'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-release-notes.cjs')
const dirs = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

/** A repository whose previous release, v1.0.0, also carries the tags a package publish pushed there. */
function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-release-notes-'))
  dirs.push(dir)
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ repository: { url: 'https://github.com/o/r.git' } }))
  git('add', 'package.json')
  git('commit', '-q', '-m', 'feat: the first thing')
  git('tag', 'v1.0.0')
  git('tag', 'client-v0.3.0')
  git('tag', 'plugin-sdk-v0.2.0')
  writeFileSync(path.join(dir, 'a.txt'), 'a')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'fix: the second thing')
  git('tag', 'v1.0.1')
  return dir
}

describe('build-release-notes', () => {
  it('counts from the app release before this one, not a package tag on the same commit', () => {
    const dir = repo()
    const r = spawnSync(process.execPath, [script, 'v1.0.1'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'o/r' } })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('https://github.com/o/r/compare/v1.0.0...v1.0.1')
    expect(r.stdout).toContain('Every change (1)')
  })
})
