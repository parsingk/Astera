// What Astera remembers about each Codex account's plugins (Codex plugin sharing design §5): the outcome file. The screen
// and the CLI read a missing or damaged file as no rows; the sync tells a damaged one apart and keeps its text beside it.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { extensionPaths } from '../../profile/paths'
import { hasKeptCopy } from '../../storeFile'
import { readCodexPluginAccounts, readCodexPluginAccountsForSync, writeCodexPluginAccounts, type CodexPluginAccountState } from './state'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codexplugin-state-'))
  dirs.push(d)
  return d
}

const rows: CodexPluginAccountState[] = [
  { accountId: 'acc_1', installed: { review: '1.2.0', docs: '0.3.1' }, waiting: false, turnedOff: ['review@acc-own'], at: '2026-11-04T01:00:00.000Z' },
  {
    accountId: 'acc_2',
    installed: {},
    waiting: true,
    failure: { message: 'The account has sessions running', code: 'timed-out' },
    turnedOff: [],
    at: '2026-11-04T01:00:01.000Z'
  },
  { accountId: 'acc_3', installed: {}, waiting: false, failure: { message: 'no code on this one' }, turnedOff: [], at: '2026-11-04T01:00:02.000Z' }
]

describe('Codex plugin outcome file', () => {
  it('reads back what was written, in order', async () => {
    const p = await profile()
    await writeCodexPluginAccounts(p, rows)
    expect(await readCodexPluginAccounts(p)).toEqual(rows)
  })

  it('writes { version: 1, accounts } where the profile paths say, and no temp file is left', async () => {
    const p = await profile()
    await writeCodexPluginAccounts(p, rows)
    const file = extensionPaths(p).codexPluginAccounts
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, accounts: rows })
    expect(await fs.readdir(path.dirname(file))).toEqual([path.basename(file)])
  })

  it('replaces the rows of an earlier write, and an empty list reads back empty', async () => {
    const p = await profile()
    await writeCodexPluginAccounts(p, rows)
    await writeCodexPluginAccounts(p, [rows[0]])
    expect(await readCodexPluginAccounts(p)).toEqual([rows[0]])
    await writeCodexPluginAccounts(p, [])
    expect(await readCodexPluginAccounts(p)).toEqual([])
  })

  it('reads a missing file as no rows', async () => {
    expect(await readCodexPluginAccounts(await profile())).toEqual([])
  })

  it('reads a damaged file as no rows and leaves it as it was', async () => {
    const p = await profile()
    const file = extensionPaths(p).codexPluginAccounts
    await fs.mkdir(path.dirname(file), { recursive: true })
    for (const text of ['{', '', 'null', '[]', '{"version":2,"accounts":[]}', '{"version":1}', '{"version":1,"accounts":{}}']) {
      await fs.writeFile(file, text)
      expect(await readCodexPluginAccounts(p), text).toEqual([])
      expect(await fs.readFile(file, 'utf8')).toBe(text)
    }
    expect((await fs.readdir(path.dirname(file))).sort()).toEqual([path.basename(file)])
  })

  // The rows hold what Codex cannot give back (which own plugins Astera turned off), so a file that could not be read
  // is never taken for a file with no rows: the next write would drop them (audit U-1).
  it('rejects with the read error when the file cannot be read, and leaves the path as it was', async () => {
    const p = await profile()
    const file = extensionPaths(p).codexPluginAccounts
    await fs.mkdir(file, { recursive: true }) // a folder where the file belongs: reading it is EISDIR
    await expect(readCodexPluginAccounts(p)).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(readCodexPluginAccountsForSync(p)).rejects.toMatchObject({ code: 'EISDIR' })
    expect((await fs.stat(file)).isDirectory()).toBe(true)
  })

  // Final review I4: the sync tells a damaged file from a missing one, since the rows it lost said which copies are in
  // use and which own plugins Astera turned off
  describe('as the sync reads it', () => {
    it('answers the rows of a file it can read, and of a missing file none, neither damaged', async () => {
      const p = await profile()
      expect(await readCodexPluginAccountsForSync(p)).toEqual({ rows: [], damaged: false })
      await writeCodexPluginAccounts(p, rows)
      expect(await readCodexPluginAccountsForSync(p)).toEqual({ rows, damaged: false })
    })

    it('answers a damaged file as damaged with no rows, keeping its text beside it first', async () => {
      const p = await profile()
      const file = extensionPaths(p).codexPluginAccounts
      await fs.mkdir(path.dirname(file), { recursive: true })
      for (const text of ['{', '{"version":2,"accounts":[]}', '{"version":1,"accounts":{}}']) {
        await fs.writeFile(file, text)
        expect(await readCodexPluginAccountsForSync(p), text).toEqual({ rows: [], damaged: true })
        expect(await hasKeptCopy(file, text), text).toBe(true)
        expect(await fs.readFile(file, 'utf8')).toBe(text)
      }
    })
  })
})
