import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RepairNeeded } from './repairNeeded'
import { mcpHttpHostsProblem, mcpHttpOf, readMcpHttp } from './mcpHttp'

const OFF = { enabled: false, port: 7871, lan: false, hosts: [] }

describe('mcpHttpOf', () => {
  it('a missing or non-object value is off with the defaults', () => {
    expect(mcpHttpOf(undefined)).toEqual(OFF)
    expect(mcpHttpOf(null)).toEqual(OFF)
    expect(mcpHttpOf('on')).toEqual(OFF)
    expect(mcpHttpOf([])).toEqual(OFF)
  })
  it('enabled and lan are true only for true', () => {
    expect(mcpHttpOf({ enabled: true, lan: true })).toMatchObject({ enabled: true, lan: true })
    expect(mcpHttpOf({ enabled: 'true', lan: 1 })).toMatchObject({ enabled: false, lan: false })
  })
  it('a bad port falls back to the default', () => {
    expect(mcpHttpOf({ port: 8080 }).port).toBe(8080)
    for (const bad of [0, -1, 70000, 80.5, '8080', NaN, null]) expect(mcpHttpOf({ port: bad }).port).toBe(7871)
  })
  it('hosts keeps only the strings', () => {
    expect(mcpHttpOf({ hosts: ['a.ts.net', 3, null, 'b'] }).hosts).toEqual(['a.ts.net', 'b'])
    expect(mcpHttpOf({ hosts: 'a' }).hosts).toEqual([])
  })
})

describe('readMcpHttp', () => {
  const file = async (text: string | null): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-mcp-http-'))
    const p = path.join(dir, 'app-settings.json')
    if (text !== null) await fs.writeFile(p, text)
    return p
  }
  it('a missing file is off', async () => {
    expect(await readMcpHttp(await file(null))).toEqual(OFF)
  })
  it('reads the stored value', async () => {
    const got = await readMcpHttp(await file('{"mcpHttp":{"enabled":true,"port":9000,"lan":true,"hosts":["h"]}}'))
    expect(got).toEqual({ enabled: true, port: 9000, lan: true, hosts: ['h'] })
  })
  it('an unreadable settings file refuses: it throws rather than answering off', async () => {
    await expect(readMcpHttp(await file('{not json'))).rejects.toBeInstanceOf(RepairNeeded)
  })
})

describe('mcpHttpHostsProblem', () => {
  it('accepts names the Host keeps, and an empty list', () => {
    expect(mcpHttpHostsProblem([])).toBeNull()
    expect(mcpHttpHostsProblem(['box.tailnet.ts.net', '10.0.0.2', 'other:9000'])).toBeNull()
    expect(mcpHttpHostsProblem(['a'.repeat(253)])).toBeNull()
  })

  it('refuses what the Host would drop or could not split', () => {
    for (const bad of [[''], ['  '], ['a,b'], ['a b'], ['a\tb'], ['a'.repeat(254)]]) expect(mcpHttpHostsProblem(bad), JSON.stringify(bad)).not.toBeNull()
    expect(mcpHttpHostsProblem(Array.from({ length: 20 }, (_, i) => `h${i}`))).toBeNull()
    expect(mcpHttpHostsProblem(Array.from({ length: 21 }, (_, i) => `h${i}`))).not.toBeNull()
  })
})
