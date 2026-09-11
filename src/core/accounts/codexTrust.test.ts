import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexTrustRoot, markCodexProjectTrusted, upsertProjectTrust } from './codexTrust'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-trust-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('upsertProjectTrust', () => {
  it('appends a block to an empty file', () => {
    expect(upsertProjectTrust('', 'D:\\p\\x')).toBe('[projects."D:\\\\p\\\\x"]\ntrust_level = "trusted"\n')
  })

  it('keeps everything that was already in the file', () => {
    const before = 'model = "gpt-5"\n\n[projects."D:\\\\p\\\\a"]\ntrust_level = "trusted"\n'
    const after = upsertProjectTrust(before, 'D:\\p\\b')
    expect(after).toContain('model = "gpt-5"')
    expect(after).toContain('[projects."D:\\\\p\\\\a"]')
    expect(after).toContain('[projects."D:\\\\p\\\\b"]')
  })

  // Writing a second block for a path that already has one makes the file ambiguous, and which one
  // codex reads is not ours to decide.
  it('rewrites the trust_level in place rather than adding a second block', () => {
    const before = '[projects."D:\\\\p\\\\a"]\ntrust_level = "untrusted"\n'
    const after = upsertProjectTrust(before, 'D:\\p\\a')
    expect(after).toBe('[projects."D:\\\\p\\\\a"]\ntrust_level = "trusted"\n')
    expect(after.match(/\[projects\./g)).toHaveLength(1)
  })

  it('adds the key to a block that has none, without touching its neighbours', () => {
    const before = '[projects."D:\\\\p\\\\a"]\nsomething = 1\n\n[other]\nkeep = true\n'
    const after = upsertProjectTrust(before, 'D:\\p\\a')
    expect(after).toContain('trust_level = "trusted"')
    expect(after).toContain('something = 1')
    expect(after).toContain('[other]\nkeep = true')
  })

  // Windows paths differ only in case and separator all the time — matching them as raw strings would
  // append a second block for the folder that already has one.
  it('matches an existing block case-insensitively on win32-shaped paths', () => {
    const before = '[projects."d:\\\\p\\\\a"]\ntrust_level = "untrusted"\n'
    const after = upsertProjectTrust(before, 'D:\\P\\A')
    expect(after.match(/\[projects\./g)).toHaveLength(1)
    expect(after).toContain('trust_level = "trusted"')
  })

  // A header inside a multi-line string is text, not a table. Treating it as one would edit the middle
  // of somebody's instructions block.
  it('ignores a header that only appears inside a multi-line string', () => {
    const before = 'notes = """\n[projects."D:\\\\p\\\\a"]\n"""\n'
    const after = upsertProjectTrust(before, 'D:\\p\\a')
    expect(after).toContain('notes = """')
    expect(after.match(/trust_level/g)).toHaveLength(1)
    expect(after.indexOf('trust_level')).toBeGreaterThan(after.indexOf('"""\n', 10))
  })

  it('keeps CRLF files on CRLF', () => {
    const after = upsertProjectTrust('model = "gpt-5"\r\n', 'D:\\p\\x')
    expect(after).toContain('\r\n[projects."D:\\\\p\\\\x"]\r\ntrust_level = "trusted"\r\n')
  })
})

describe('codexTrustRoot', () => {
  it('returns a plain directory unchanged', async () => {
    expect(await codexTrustRoot(dir)).toBe(dir)
  })

  // Codex resolves a worktree to the repository it belongs to, so trusting the worktree path alone
  // would write an entry codex never reads.
  it('resolves a git worktree to the repository root', async () => {
    const repo = path.join(dir, 'repo')
    const wt = path.join(dir, 'wt')
    const gitDir = path.join(repo, '.git', 'worktrees', 'wt')
    await fs.mkdir(gitDir, { recursive: true })
    await fs.mkdir(wt, { recursive: true })
    await fs.writeFile(path.join(wt, '.git'), `gitdir: ${gitDir}\n`, 'utf8')
    await fs.writeFile(path.join(gitDir, 'gitdir'), `${path.join(wt, '.git')}\n`, 'utf8')
    expect(await codexTrustRoot(wt)).toBe(repo)
  })

  // The .git file lives in the workspace, so a worker could write one pointing anywhere. Git's own
  // reciprocal link is the check that the repository agrees.
  it('refuses to widen trust when the repository does not link back', async () => {
    const repo = path.join(dir, 'repo')
    const wt = path.join(dir, 'wt')
    const gitDir = path.join(repo, '.git', 'worktrees', 'wt')
    await fs.mkdir(gitDir, { recursive: true })
    await fs.mkdir(wt, { recursive: true })
    await fs.writeFile(path.join(wt, '.git'), `gitdir: ${gitDir}\n`, 'utf8')
    await fs.writeFile(path.join(gitDir, 'gitdir'), path.join(dir, 'somewhere-else', '.git'), 'utf8')
    expect(await codexTrustRoot(wt)).toBe(wt)
  })

  it('leaves an ordinary git checkout alone', async () => {
    const repo = path.join(dir, 'repo')
    await fs.mkdir(path.join(repo, '.git'), { recursive: true })
    expect(await codexTrustRoot(repo)).toBe(repo)
  })
})

describe('markCodexProjectTrusted', () => {
  it('creates config.toml when the account has none', async () => {
    await markCodexProjectTrusted(dir, 'D:\\p\\x')
    const raw = await fs.readFile(path.join(dir, 'config.toml'), 'utf8')
    expect(raw).toContain('[projects."D:\\\\p\\\\x"]')
    expect(raw).toContain('trust_level = "trusted"')
  })

  it('keeps the rest of an existing config and backs it up first', async () => {
    const file = path.join(dir, 'config.toml')
    await fs.writeFile(file, 'model = "gpt-5"\n', 'utf8')
    await markCodexProjectTrusted(dir, 'D:\\p\\x')
    expect(await fs.readFile(file, 'utf8')).toContain('model = "gpt-5"')
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('model = "gpt-5"\n')
  })

  // Every worker start would otherwise rewrite the file — and back it up over its own backup.
  it('does not rewrite a file that already says trusted', async () => {
    await markCodexProjectTrusted(dir, 'D:\\p\\x')
    const file = path.join(dir, 'config.toml')
    const first = await fs.stat(file)
    await markCodexProjectTrusted(dir, 'D:\\p\\x')
    expect((await fs.stat(file)).mtimeMs).toBe(first.mtimeMs)
  })
})
