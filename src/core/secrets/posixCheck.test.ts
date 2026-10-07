import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { pathChain, posixProblem, symlinkProblem, type StatLike } from './posixCheck'

const P = path.resolve(path.sep === '\\' ? 'C:\\' : '/', 'home', 'u', '.astera')
const file = path.join(P, 'remote', 'clients.json')
const st = (o: Partial<{ link: boolean; dir: boolean; uid: number; mode: number }> = {}): StatLike => ({
  isSymbolicLink: () => o.link ?? false,
  isDirectory: () => o.dir ?? false,
  uid: o.uid ?? 1000,
  mode: o.mode ?? 0o600
})
/** Every path is an owner-only directory unless named here; the leaf files are owner-only files. */
const fsOver = (over: Record<string, StatLike>, leaf = file) => (p: string): StatLike =>
  over[p] ?? (p === leaf ? st({ mode: 0o600 }) : st({ dir: true, mode: 0o700 }))

describe('pathChain', () => {
  it('walks from the file up to, not including, the profile directory', () => {
    expect(pathChain(file, P)).toEqual([file, path.join(P, 'remote')])
  })
  it('refuses a file outside the profile directory, and the profile directory itself', () => {
    expect(() => pathChain(path.join(P, '..', 'x'), P)).toThrow()
    expect(() => pathChain(P, P)).toThrow()
  })
})

describe('symlinkProblem', () => {
  it('refuses a symlink or junction anywhere on the chain', () => {
    const chain = pathChain(file, P)
    expect(symlinkProblem(chain, fsOver({}))).toBeNull()
    expect(symlinkProblem(chain, fsOver({ [path.join(P, 'remote')]: st({ link: true }) }))).toMatch(/symbolic link/)
  })
})

describe('posixProblem (remote runtime design §4.6, D5.3)', () => {
  const chain = pathChain(file, P)
  it('accepts an owner-only file in an owner-only directory', () => {
    expect(posixProblem(chain, fsOver({}), 1000)).toBeNull()
  })
  it('refuses another owner, and any group or other bit on the file or the store directory', () => {
    expect(posixProblem(chain, fsOver({ [file]: st({ uid: 0 }) }), 1000)).toMatch(/owned by uid 0/)
    expect(posixProblem(chain, fsOver({ [file]: st({ mode: 0o640 }) }), 1000)).toMatch(/mode 640/)
    expect(posixProblem(chain, fsOver({ [path.join(P, 'remote')]: st({ dir: true, mode: 0o750 }) }), 1000)).toMatch(/mode 750/)
  })
  it('a file that passed is refused once its mode widens (Review Focus 3)', () => {
    const files: Record<string, StatLike> = {}
    expect(posixProblem(chain, fsOver(files), 1000)).toBeNull()
    files[file] = st({ mode: 0o604 })
    expect(posixProblem(chain, fsOver(files), 1000)).not.toBeNull()
  })
  it('lets a directory above the store be read by others, never written', () => {
    const deep = path.join(P, 'a', 'remote', 'clients.json')
    const above = path.join(P, 'a')
    const deepChain = pathChain(deep, P)
    expect(deepChain).toEqual([deep, path.join(P, 'a', 'remote'), above])
    expect(posixProblem(deepChain, fsOver({ [above]: st({ dir: true, mode: 0o755 }) }, deep), 1000)).toBeNull()
    expect(posixProblem(deepChain, fsOver({ [above]: st({ dir: true, mode: 0o775 }) }, deep), 1000)).toMatch(/group or other writable/)
  })
})
