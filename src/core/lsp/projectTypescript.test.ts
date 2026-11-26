import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { projectTypescriptMajor } from './projectTypescript'

// Phase 3 Part 3: which TypeScript a project uses, read as data from its files (never run), to pick typescript5 below 6
const root = path.resolve('proj')
const files = (map: Record<string, string>) => async (p: string): Promise<string | null> => map[path.relative(root, p).replace(/\\/g, '/')] ?? null
const pkg = (deps: Record<string, unknown>) => JSON.stringify(deps)

describe('projectTypescriptMajor', () => {
  it('reads the installed TypeScript before the declared range', async () => {
    const read = files({ 'node_modules/typescript/package.json': pkg({ name: 'typescript', version: '5.4.5' }), 'package.json': pkg({ devDependencies: { typescript: '^7.0.2' } }) })
    expect(await projectTypescriptMajor(root, read)).toBe(5)
  })

  it('reads the first number of a range, from devDependencies then dependencies', async () => {
    const cases: Array<[unknown, number | null]> = [['^5.9.0', 5], ['~4.9', 4], ['>=5 <6', 5], ['5.x', 5], ['7.0.2', 7], ['latest', null], ['*', null], ['workspace:*', null], [3, null]]
    for (const [range, want] of cases) expect(await projectTypescriptMajor(root, files({ 'package.json': pkg({ devDependencies: { typescript: range } }) })), String(range)).toBe(want)
    expect(await projectTypescriptMajor(root, files({ 'package.json': pkg({ dependencies: { typescript: '^4.2' } }) }))).toBe(4)
  })

  it('says nothing for a project with neither, or with files that are not JSON', async () => {
    expect(await projectTypescriptMajor(root, files({}))).toBeNull()
    expect(await projectTypescriptMajor(root, files({ 'package.json': '{ not json', 'node_modules/typescript/package.json': 'nope' }))).toBeNull()
    expect(await projectTypescriptMajor(root, files({ 'node_modules/typescript/package.json': pkg({ version: 'x' }) }))).toBeNull()
  })
})
