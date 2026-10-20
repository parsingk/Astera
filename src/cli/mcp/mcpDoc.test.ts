// docs/mcp.md and `astera mcp serve`'s usage against the tools they describe (the 4b review's M1 and M2): how many
// there are, which take a requestId, and which list tools page as the rest do.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_TOOLS, TOOLS } from './tools'
import { USAGE } from '../../core/orchestration/cliUsage'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const mcpDoc = readFileSync(path.join(root, 'docs/mcp.md'), 'utf8')
const cliDoc = readFileSync(path.join(root, 'docs/cli.md'), 'utf8')
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen']
const TENS: Record<number, string> = { 30: 'thirty', 40: 'forty', 50: 'fifty' }
const inWords = (n: number): string => (n < WORDS.length ? WORDS[n] : `${TENS[n - (n % 10)]}${n % 10 === 0 ? '' : `-${WORDS[n % 10]}`}`)
const withRequestId = TOOLS.filter((t) => 'requestId' in t.inputSchema).map((t) => t.name).sort()
const named = (text: string): string[] => [...new Set([...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))].sort()

describe('docs/mcp.md', () => {
  it('counts the tools', () => {
    expect(mcpDoc).toContain(`The server offers ${TOOLS.length} tools`)
  })
  it('names every tool that takes a requestId, and counts them', () => {
    const m = /The (\w+) tools that change something \(([^)]*)\) accept an optional `requestId`/.exec(mcpDoc.replace(/\s+/g, ' '))
    expect(m).not.toBeNull()
    expect(m![1]).toBe(inWords(withRequestId.length))
    expect(named(m![2])).toEqual(withRequestId)
  })
  // G8 final review M4: a GitHub lifecycle Run's record carries `github`, and the tool that returns it whole says so
  it('says get_work_record returns a lifecycle Run’s GitHub evidence', () => {
    const tool = TOOLS.find((t) => t.name === 'get_work_record')!
    expect(tool.description).toMatch(/GitHub evidence \(`github`/)
    const row = mcpDoc.split('\n').find((l) => l.startsWith('| `get_work_record` |'))!
    expect(row).toMatch(/GitHub evidence \(`github`/)
  })
  it('says which list tools do not take a limit or a cursor of MCP’s own', () => {
    const at = mcpDoc.indexOf('Every list tool takes a `limit`')
    const rules = mcpDoc.slice(at, mcpDoc.indexOf('\nEvery result carries the data twice', at))
    for (const t of ['list_job_sources', 'list_source_items']) expect(rules, t).toContain(`\`${t}\``)
  })
})

describe('astera mcp serve, in its usage and in docs/cli.md', () => {
  const served = TOOLS.length
  it('counts the tools it serves, and names the job sources among them', () => {
    expect(RUNTIME_TOOLS.size).toBeGreaterThan(0)
    const detail = USAGE['mcp-serve'].detail ?? ''
    const para = cliDoc.slice(cliDoc.indexOf('**`mcp serve` is for an MCP client to launch'), cliDoc.indexOf('**`mcp status` says'))
    for (const text of [detail, para.replace(/\s+/g, ' ')]) {
      expect(text).toContain(`${inWords(served)} tools`)
      expect(text).toContain('job sources')
    }
    for (const t of withRequestId) expect(para, t).toContain(`\`${t}\``)
  })
})
