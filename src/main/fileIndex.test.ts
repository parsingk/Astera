import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createFileIndex } from './fileIndex'

describe('createFileIndex', () => {
  let root: string

  const write = async (rel: string, text = 'x'): Promise<void> => {
    const file = path.join(root, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text, 'utf8')
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-idx-'))
    await write('README.md')
    await write('src/app.ts')
    await write('src/core/conversation.ts')
    await write('node_modules/pkg/index.js')
    await write('dist/bundle.js')
    await write('secret/keys.txt')
    await write('.gitignore', 'secret/\n')
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  })

  // The whole value of the list is what is NOT in it: a repository's node_modules is larger than the
  // repository, and a menu that offers it offers nothing.
  it('leaves out what the curated list and the .gitignore exclude', async () => {
    const all = await createFileIndex().search(root, '', 100)
    expect(all).toContain('README.md')
    expect(all).toContain('src/core/conversation.ts')
    expect(all.some((p) => p.includes('node_modules'))).toBe(false)
    expect(all.some((p) => p.startsWith('dist/'))).toBe(false)
    expect(all.some((p) => p.startsWith('secret/'))).toBe(false)
  })

  it('answers root-relative paths with forward slashes, whatever the platform writes', async () => {
    const found = await createFileIndex().search(root, 'conversation', 10)
    expect(found).toEqual(['src/core/conversation.ts'])
  })

  it('answers an empty list for a root that is not there, rather than throwing', async () => {
    await expect(createFileIndex().search(path.join(root, 'nope'), '', 10)).resolves.toEqual([])
    await expect(createFileIndex().search('', '', 10)).resolves.toEqual([])
  })

  // Typing a name is one call per keystroke; walking the tree again on each would make the menu
  // slower the larger the project is, which is exactly backwards.
  it('walks once and reuses the list until it goes stale', async () => {
    let clock = 0
    const index = createFileIndex(() => clock)
    expect(await index.search(root, 'app', 10)).toEqual(['src/app.ts'])

    await write('src/added.ts')
    expect(await index.search(root, 'added', 10)).toEqual([]) // still the walked list

    clock += 60_000
    expect(await index.search(root, 'added', 10)).toEqual(['src/added.ts'])
  })
})
