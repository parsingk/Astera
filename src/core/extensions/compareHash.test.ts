// Remote Runtime governance §6.2: the comparison hash a controller uses to tell whether a Runtime holds the same
// skill, command or agent. It ignores CRLF in text files and OS metadata files, unlike the registry hash.
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { extensionPaths } from '../profile/paths'
import { hashTree } from './hash'
import { compareHashFile, compareHashOf, compareHashTree, isOsMetadata } from './compareHash'
import type { FileExtension } from './types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cmp-'))
  dirs.push(d)
  return d
}

async function write(file: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

describe('isOsMetadata', () => {
  it('names the OS metadata files and nothing else', () => {
    for (const n of ['.DS_Store', '._SKILL.md', '._', 'Thumbs.db', 'thumbs.DB', 'desktop.ini', 'DESKTOP.INI']) expect(isOsMetadata(n), n).toBe(true)
    for (const n of ['SKILL.md', '.ds_store', '_x', '.gitignore', 'Thumbs.db.bak', 'my.desktop.ini']) expect(isOsMetadata(n), n).toBe(false)
  })
})

describe('compareHashTree', () => {
  it('a skill with CRLF line endings hashes the same as its LF copy, while hashTree does not', async () => {
    const root = await tmp()
    const crlf = path.join(root, 'crlf')
    const lf = path.join(root, 'lf')
    await write(path.join(crlf, 'SKILL.md'), 'a\r\nb\r\n')
    await write(path.join(lf, 'SKILL.md'), 'a\nb\n')
    expect(await compareHashTree(crlf)).toBe(await compareHashTree(lf))
    expect(await hashTree(crlf)).not.toBe(await hashTree(lf))
  })

  it('OS metadata files are left out at any depth', async () => {
    const dir = path.join(await tmp(), 'skill')
    await write(path.join(dir, 'SKILL.md'), '# s\n')
    await write(path.join(dir, 'sub', 'ref.md'), 'r\n')
    const before = await compareHashTree(dir)
    await write(path.join(dir, '.DS_Store'), 'x')
    await write(path.join(dir, '._SKILL.md'), 'x')
    await write(path.join(dir, 'sub', 'Thumbs.db'), 'x')
    await write(path.join(dir, 'sub', 'DESKTOP.INI'), 'x')
    expect(await compareHashTree(dir)).toBe(before)
  })

  it('a binary file is hashed as its bytes', async () => {
    const dir = path.join(await tmp(), 'skill')
    await write(path.join(dir, 'blob.bin'), Buffer.from([0x61, 0x00, 0x0d, 0x0a, 0x62]))
    const before = await compareHashTree(dir)
    await write(path.join(dir, 'blob.bin'), Buffer.from([0x61, 0x00, 0x0a, 0x62]))
    expect(await compareHashTree(dir)).not.toBe(before)
  })

  it('different text is a different hash', async () => {
    const root = await tmp()
    await write(path.join(root, 'one', 'SKILL.md'), 'a\n')
    await write(path.join(root, 'two', 'SKILL.md'), 'b\n')
    expect(await compareHashTree(path.join(root, 'one'))).not.toBe(await compareHashTree(path.join(root, 'two')))
  })

  it('nested paths are joined with / on every OS', async () => {
    const dir = path.join(await tmp(), 'skill')
    await write(path.join(dir, 'a', 'b.md'), 'x\r\n')
    const expected = `cmp1:sha256:${createHash('sha256').update('a/b.md\0' + 'x\n' + '\0').digest('hex')}`
    expect(await compareHashTree(dir)).toBe(expected)
  })

  // Final review F11: macOS has handed out file names decomposed (NFD) where Windows and Linux keep what was typed (NFC
  // as a rule), so the same skill copied across can name its files in either form
  it('a file named in NFD and the same name in NFC hash the same, in the same order', async () => {
    const nfc = 'caf' + String.fromCharCode(0xe9)
    const nfd = 'cafe' + String.fromCharCode(0x301)
    expect(nfd.normalize('NFC')).toBe(nfc)
    const a = path.join(await tmp(), 'skill')
    const b = path.join(await tmp(), 'skill')
    for (const [dir, name] of [[a, nfc], [b, nfd]]) {
      await write(path.join(dir, `${name}.md`), 'same\n')
      await write(path.join(dir, `${name}`, 'x.md'), 'deep\n')
      await write(path.join(dir, 'cafe.md'), 'other\n')
    }
    expect(await compareHashTree(b)).toBe(await compareHashTree(a))
    const expected = `cmp1:sha256:${createHash('sha256')
      .update('cafe.md\0other\n\0')
      .update(`${nfc}.md\0same\n\0`)
      .update(`${nfc}/x.md\0deep\n\0`)
      .digest('hex')}`
    expect(await compareHashTree(b)).toBe(expected)
  })
})

describe('compareHashFile', () => {
  it('a command file compares the same with CRLF and LF', async () => {
    const root = await tmp()
    await write(path.join(root, 'crlf.md'), 'ship\r\nit\r\n')
    await write(path.join(root, 'lf.md'), 'ship\nit\n')
    const h = await compareHashFile(path.join(root, 'crlf.md'))
    expect(h).toBe(await compareHashFile(path.join(root, 'lf.md')))
    expect(h).toMatch(/^cmp1:sha256:[0-9a-f]{64}$/)
  })

  it('a lone CR is kept', async () => {
    const root = await tmp()
    await write(path.join(root, 'cr.md'), 'a\rb')
    await write(path.join(root, 'lf.md'), 'a\nb')
    expect(await compareHashFile(path.join(root, 'cr.md'))).not.toBe(await compareHashFile(path.join(root, 'lf.md')))
  })

  // The text test reads exactly the first 8000 bytes (indexes 0 to 7999), as git does.
  const withNulAt = (index: number, eol: string): Buffer => Buffer.concat([Buffer.alloc(index, 0x61), Buffer.from([0]), Buffer.from(eol)])

  it('a NUL at index 7999 makes the file binary, so its CRLF is kept', async () => {
    const root = await tmp()
    await write(path.join(root, 'crlf.bin'), withNulAt(7999, '\r\n'))
    await write(path.join(root, 'lf.bin'), withNulAt(7999, '\n'))
    expect(await compareHashFile(path.join(root, 'crlf.bin'))).not.toBe(await compareHashFile(path.join(root, 'lf.bin')))
  })

  it('a NUL at index 8000 leaves the file text, so its CRLF is folded', async () => {
    const root = await tmp()
    await write(path.join(root, 'crlf.txt'), withNulAt(8000, '\r\n'))
    await write(path.join(root, 'lf.txt'), withNulAt(8000, '\n'))
    expect(await compareHashFile(path.join(root, 'crlf.txt'))).toBe(await compareHashFile(path.join(root, 'lf.txt')))
  })
})

describe('compareHashOf', () => {
  it('compareHashOf reads the canonical copy of a skill and of an agent', async () => {
    const profileDir = path.join(await tmp(), 'profile')
    const p = extensionPaths(profileDir)
    await write(path.join(p.skills, 'review', 'SKILL.md'), '# review\r\n')
    await write(path.join(p.agents, 'helper.md'), 'help\r\n')
    const base = { hash: 'sha256:x', providers: ['claude' as const], importedFrom: 'acc_0', enabled: true }
    const skill: FileExtension = { ...base, id: 'skill-review', kind: 'skill', name: 'review' }
    const agent: FileExtension = { ...base, id: 'agent-helper', kind: 'agent', name: 'helper' }
    expect(await compareHashOf(profileDir, skill)).toBe(`cmp1:sha256:${createHash('sha256').update('SKILL.md\0' + '# review\n' + '\0').digest('hex')}`)
    expect(await compareHashOf(profileDir, agent)).toBe(await compareHashFile(path.join(p.agents, 'helper.md')))
    expect(await compareHashOf(profileDir, agent)).toBe(`cmp1:sha256:${createHash('sha256').update('help\n').digest('hex')}`)
  })
})
