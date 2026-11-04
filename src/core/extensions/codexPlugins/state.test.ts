// What Astera remembers about each Codex account's plugins (Codex plugin sharing design §5): the outcome file. A missing
// or damaged file reads as no rows, so the next sync works every account out again and writes the file anew.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { extensionPaths } from '../../profile/paths'
import { readCodexPluginAccounts, writeCodexPluginAccounts, type CodexPluginAccountState } from './state'

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
})
