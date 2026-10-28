// docs/sdk.md and this package's README are checked against the code they describe: every typed method, event type,
// local error code and default they name is the package's, every TypeScript block compiles against it, every link
// lands, and the guide is not left out of git by docs/'s whitelist.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CALL_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS } from './client.js'
import { DEFAULT_WAIT_TIMEOUT_MS } from './deadlines.js'
import { ERROR_CODES, REMOTE_ERROR_CODES } from './errors.js'
import { EVENTS_RETRY_MS } from './events.js'
import { EVENT_TYPES } from './fields.js'
import { createNamespaces } from './namespaces.js'
import * as pkg from './index.js'
import { typecheckBlocks } from '../test/typecheck.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (f: string): string => readFileSync(path.join(root, f), 'utf8')
const guide = read('docs/sdk.md')
const readme = read('packages/client/README.md')

/** One section, from its heading to the next heading of the same or a higher level. */
const section = (doc: string, heading: string): string => {
  const at = doc.indexOf(`\n${heading}\n`)
  if (at < 0) return ''
  const level = heading.match(/^#+/)![0].length
  const rest = doc.slice(at + heading.length + 2)
  const end = rest.search(new RegExp(`\\n#{1,${level}} `))
  return end < 0 ? rest : rest.slice(0, end)
}
const blocks = (doc: string): string[] => [...doc.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1])
/** GitHub's heading anchor, for the headings these docs use. */
const slug = (h: string): string => h.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-')
const anchors = (doc: string): Set<string> => new Set([...doc.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])))
/** The text outside its fenced blocks: what a reader takes as a statement, not as code that compiles. */
const prose = (doc: string): string => doc.replace(/^```[\s\S]*?^```$/gm, '')
/** A whole-number constant of the Host's source, `export const NAME = 60 * 60 * 1000` and the like. Read as text: the
 *  package's tests do not import the app, whose imports its compiler options do not resolve. */
const hostConstant = (file: string, name: string): number => {
  const m = new RegExp(`^export const ${name} = ([\\d_ *]+)$`, 'm').exec(read(file))
  if (!m) throw new Error(`${file} has no ${name}`)
  return m[1].split('*').reduce((n, f) => n * Number(f.trim().replace(/_/g, '')), 1)
}
/** The members of a string-literal union of the Host's source or this package's, `export type NAME =\n  | 'a'\n  | 'b'`,
 *  read as text for the same reason. */
/** A string union's members, read from its source: one `  | 'member'` per line, doc comments between them stepped over. */
const unionOf = (file: string, name: string): string[] => {
  const lines = read(file).split(/\r?\n/)
  const at = lines.findIndex((l) => l.startsWith(`export type ${name} =`))
  if (at < 0) throw new Error(`${file} has no ${name}`)
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    const member = /^ {2}\| '([\w-]+)'$/.exec(l)
    if (member) out.push(member[1])
    else if (!/^ {2}(\/\*\*|\/\/)/.test(l)) break
  }
  return out
}
const RECEIPT_TTL_MS = hostConstant('src/host/orch.ts', 'RECEIPT_TTL_MS')
const RECEIPTS_PER_CALLER = hostConstant('src/host/orch.ts', 'RECEIPTS_PER_CALLER')
const SEGMENT_EVENTS = hostConstant('src/host/eventLog.ts', 'EVENT_SEGMENT_EVENTS')
const SEGMENT_MIB = hostConstant('src/host/eventLog.ts', 'EVENT_SEGMENT_BYTES') / 1024 / 1024
const RETAIN_EVENTS = hostConstant('src/host/eventLog.ts', 'EVENT_RETAIN_EVENTS')
const methods = Object.entries(createNamespaces(() => Promise.reject(new Error('no Host')), () => [])).flatMap(([name, api]) =>
  Object.keys(api as object).map((m) => `${name}.${m}`)
)

describe('docs/sdk.md', () => {
  it('names every typed method', () => {
    expect(methods.length).toBeGreaterThan(20)
    for (const m of methods) expect(guide, m).toContain(m)
    for (const m of ['call(', 'close()', 'hasFeature(', 'host.features']) expect(guide, m).toContain(m)
  })

  // Final review of SDK 1e, minor 1: a method the package lacks, named in a sentence, passed
  it('names no method the package does not have', () => {
    const named = [...prose(guide).matchAll(/(?<![\w/.-])(projects|jobs|runs|tasks|questions|completion|events|agentProfiles)\.([A-Za-z_]+)\b/g)].map((m) => `${m[1]}.${m[2]}`)
    const known = new Set<string>([...methods, ...EVENT_TYPES, 'runs.cancel'])
    expect(named.length).toBeGreaterThan(20)
    expect(named.filter((n) => !known.has(n))).toEqual([])
  })

  // GitHub lifecycle G3c2: GitHubLifecycle.state is a union typed twice, in the Host and here; a state the Host derives
  // and the package does not name leaves a script's switch with a case it cannot write
  it('types every GitHub lifecycle state the Host derives, and names each', () => {
    const states = unionOf('src/core/github/view.ts', 'GitHubLifecycleState')
    expect(states).toContain('waiting-for-user')
    expect(unionOf('packages/client/src/types.ts', 'GitHubLifecycleState')).toEqual(states)
    for (const s of states) expect(section(guide, '## What you can do'), s).toContain(`\`${s}\``)
  })

  // GitHub lifecycle G5b final review M9: why merge-ready was withheld or withdrawn is a code a script switches on
  it('types every reason merge-ready is withheld or withdrawn for, as the Host does, and names each', () => {
    const reasons = unionOf('src/core/github/lifecycle.ts', 'GitHubInvalidatedReason')
    expect(reasons).toContain('checks-changed')
    expect(unionOf('packages/client/src/types.ts', 'GitHubInvalidatedReason')).toEqual(reasons)
    for (const r of reasons) expect(section(guide, '## What you can do'), r).toContain(`\`${r}\``)
  })

  // GitHub lifecycle G7c: RunEventKind is typed twice too; a kind the Host's timeline makes and the package does not
  // name, or the guide does not, is a line a script cannot switch on
  it('types every timeline kind the Host makes, as the Host does, and names each', () => {
    const kinds = unionOf('src/core/types.ts', 'JobEventKind')
    expect(kinds).toContain('github-merge-ready')
    expect(unionOf('packages/client/src/types.ts', 'RunEventKind')).toEqual(kinds)
    // In the paragraph that lists them, where a missing one shows (final review M6)
    const at = guide.indexOf("An event's `kind` is one of")
    const paragraph = guide.slice(at, guide.indexOf('\n\n', at))
    expect(at).toBeGreaterThan(0)
    for (const k of kinds) expect(paragraph, k).toContain(`\`${k}\``)
  })

  it('names every event type in its Events section, and the README does too', () => {
    const events = section(guide, '## Events')
    for (const t of EVENT_TYPES) {
      expect(events, t).toContain(`\`${t}\``)
      expect(readme, t).toContain(`\`${t}\``)
    }
  })

  // Final review of plugin slice 3a, minor 3: `INVALID_ARGUMENT` was written for `INVALID_ARGUMENTS`, and code that
  // compares an error's code against the written one never matches
  it('names no error code the package does not have, here or in the README', () => {
    const exported = new Set(Object.keys(pkg))
    for (const text of [guide, readme]) {
      const named = [...text.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map((m) => m[1]).filter((n) => !n.startsWith('ASTERA_') && !exported.has(n))
      expect(named.filter((n) => !(ERROR_CODES as readonly string[]).includes(n))).toEqual([])
    }
    expect([...guide.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].length).toBeGreaterThan(20)
  })

  it('names every local error code in its Errors section', () => {
    const errors = section(guide, '## Errors')
    for (const c of ERROR_CODES.filter((c) => !(REMOTE_ERROR_CODES as readonly string[]).includes(c))) expect(errors, c).toContain(`\`${c}\``)
  })

  // Final review of SDK 1e, Important 4: '5 s' was also in 'then every 5 s', so a stale connect default passed
  it('gives the deadlines and waits the code uses, each where it states it', () => {
    const connect = `${DEFAULT_CONNECT_TIMEOUT_MS / 1000} s`
    const call = `${DEFAULT_CALL_TIMEOUT_MS / 1000} s`
    const wait = `${DEFAULT_WAIT_TIMEOUT_MS / 3_600_000} hour`
    const retry = [`${EVENTS_RETRY_MS[0]} ms`, `${EVENTS_RETRY_MS[1] / 1000} s`, `${EVENTS_RETRY_MS[2] / 1000} s`]
    expect(guide).toContain(`| \`connectTimeoutMs\` | ${connect} |`)
    expect(guide).toContain(`| \`callTimeoutMs\` | ${call} |`)
    expect(guide).toContain(`The handshake waits ${connect} and an ordinary command ${call}`)
    expect(guide).toContain(`The Host waits ${wait} unless`)
    expect(guide).toContain(`(${wait} when not given)`)
    expect(guide).toContain(`after ${retry[0]}, ${retry[1]}, then every ${retry[2]}`)
    // And no other duration: one that is not a default the code has is a stale one
    const durations = [...prose(guide).matchAll(/\b\d+ (?:ms|s|hours?)\b/g)].map((m) => m[0])
    expect(durations.length).toBeGreaterThanOrEqual(8)
    expect(durations.filter((d) => ![connect, call, wait, `${RECEIPT_TTL_MS / 3_600_000} hour`, ...retry].includes(d))).toEqual([])
  })

  it('gives the event log the bounds the Host keeps, in the guide and the README', () => {
    const bounds = `two files of up to ${SEGMENT_EVENTS} events or ${SEGMENT_MIB} MiB each, so between ${SEGMENT_EVENTS} and ${RETAIN_EVENTS} events`
    expect(guide).toContain(bounds)
    expect(readme.replace(/\s+/g, ' ')).toContain(bounds)
  })

  // Final review of SDK 1e, Important 1: receipts live in the Host's memory, so a restart forgets every id
  it('says what a request id protects, for how long, and what it does not', () => {
    const retries = section(guide, '## Retries and request ids')
    expect(retries).toContain(`for ${RECEIPT_TTL_MS / 3_600_000} hour`)
    expect(retries).toContain(`the last ${RECEIPTS_PER_CALLER}`)
    expect(retries).toContain("in the Host's memory")
    expect(retries).toMatch(/restart/)
    expect(retries).toContain("call('requests-show'")
    expect(retries).toContain('`CONFLICT`')
    expect(retries).toContain('`INVALID_ARGUMENTS`')
    expect(retries).not.toMatch(/however often your program runs/)
    expect(readme.replace(/\s+/g, ' ')).toContain("receipts live in the Host's memory")
  })

  // Important 2: the protocol is in the Host's address, so another protocol's client finds nobody there
  it('says a client of another protocol finds no Host, and what to do about it', () => {
    expect(section(guide, '## Host versions and features')).toMatch(/protocol version is part of the Host's address/)
    const notRunning = section(guide, '## Troubleshooting')
      .split('\n\n')
      .find((p) => p.trim().startsWith('**`HOST_NOT_RUNNING`'))
    expect(notRunning).toContain('same version as the app')
  })

  // Important 3: Discord's own webhook refuses a body without `content`; its Slack-compatible one takes `text`
  it('says how to point the webhook example at Discord', () => {
    expect(section(guide, '## Examples')).toContain('/slack')
    expect(read('examples/sdk/notify-webhook.ts')).toContain('/slack')
  })

  // Minors 3, 4 and 5
  it('says which Node runs the examples as they are, that the SDK builds without install scripts, and what a lookup costs a deadline', () => {
    for (const doc of [section(guide, '## Examples'), read('examples/sdk/README.md')]) {
      expect(doc).toContain('23.6')
      expect(doc).toContain('npm ci --ignore-scripts')
    }
    expect(section(guide, '## Get it')).toContain('npm ci --ignore-scripts')
    expect(section(guide, '## Deadlines and cancellation')).toContain('gives each of its two calls that long')
  })

  it('says what the spec asks it to', () => {
    expect(guide).toContain("Build integrations and automation on top of Astera's durable Host with the official TypeScript client.")
    expect(guide).toMatch(/[Cc]ancelling a call is not cancelling a Run/)
    expect(guide).toMatch(/npm run build:packages/)
    // On npm (SDK packages on npm): installed by name, and built from a clone only for what is not released yet
    expect(section(guide, '## Get it')).toContain('npm install @astera-app/client')
    expect(guide).not.toMatch(/not on npm yet/)
    expect(guide).toMatch(/requestId/)
    expect(guide).toMatch(/\{ items, nextCursor \}/)
    expect(guide).toContain("the subscription's own `cursor`")
  })

  it('every TypeScript block of the guide and the README compiles against the package', () => {
    const all = [...blocks(guide), ...blocks(readme)]
    expect(blocks(guide).length).toBeGreaterThanOrEqual(8)
    // Minor 2: a README fence renamed to ```typescript would drop out of the check without a word
    expect(blocks(readme).length).toBeGreaterThanOrEqual(3)
    expect(typecheckBlocks(all)).toBe('')
  }, 60_000)

  it('every link lands on a file, and an anchor on a heading there', () => {
    const links = [...guide.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^[a-z]+:/.test(l))
    expect(links.length).toBeGreaterThan(5)
    for (const l of links) {
      const [file, anchor] = l.split('#')
      const target = file === '' ? path.join(root, 'docs', 'sdk.md') : path.resolve(root, 'docs', file)
      expect(existsSync(target), l).toBe(true)
      if (anchor !== undefined) expect(anchors(readFileSync(target, 'utf8')).has(anchor), l).toBe(true)
    }
  })

  it('links every example, and the examples README lists each', () => {
    const examples = readdirSync(path.join(root, 'examples', 'sdk')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(examples.length).toBe(4)
    const list = read('examples/sdk/README.md')
    for (const f of examples) {
      expect(guide, f).toContain(`](../examples/sdk/${f})`)
      expect(list, f).toContain(`](${f})`)
    }
  })

  // SDK packages on npm: the README is the package's page there
  it('tells a reader of its npm page how to install it, and that it is versioned apart from the app', () => {
    expect(readme).toContain('npm install @astera-app/client')
    expect(readme).not.toMatch(/not published/i)
    expect(readme).toContain('CHANGELOG.md')
    expect(read('examples/sdk/README.md')).not.toMatch(/not on npm yet/)
  })

  // 5a final review M8: a script on an older Astera meets none of it, and the CHANGELOG says which Astera it needs
  it('says which Astera the completion check plugins need, and how the CLI refuses a missing one', () => {
    const changelog = read('packages/client/CHANGELOG.md')
    const v030 = changelog.slice(changelog.indexOf('## 0.3.0'), changelog.indexOf('## 0.2.0'))
    const checks = v030.slice(v030.indexOf('- Completion check plugins'))
    expect(checks.slice(0, checks.indexOf('\n- '))).toContain('Astera 1.4.14')
    const code = v030.slice(v030.indexOf('- The error code `PLUGIN_CAPABILITY_MISSING`'))
    expect(code).toContain('Astera 1.4.14')
    const cli = read('docs/cli.md').replace(/\s+/g, ' ')
    expect(cli).toContain('or is disabled, with `PLUGIN_CAPABILITY_MISSING` in `error.code`')
  })

  // Agent Profiles design §6: the profile a Job or Task runs as, and the reads, in the guide and the CHANGELOG
  it('names the profile reads and agentProfileId in the guide and in the CHANGELOG’s 0.5.0 entry', () => {
    expect(guide).toContain('agentProfileId')
    const changelog = read('packages/client/CHANGELOG.md')
    const v050 = changelog.slice(changelog.indexOf('## 0.5.0'), changelog.indexOf('## 0.4.0'))
    expect(changelog.indexOf('## 0.5.0')).toBeGreaterThan(0)
    for (const named of ['agentProfiles.list', 'agentProfiles.get', 'agentProfileId', 'AgentProfile']) expect(v050, named).toContain(named)
    // A Host from before agent profiles, said in the guide (fix round 1)
    expect(prose(guide).replace(/\s+/g, ' ')).toContain('ignores `agentProfileId` on `jobs.create`')
  })

  // Observe mode design §10: a Run's and a Task's tokens, in the guide, the CLI guide and the CHANGELOG's 0.5.0 entry
  it('names the token totals in the guide, the CLI guide and the CHANGELOG’s 0.5.0 entry', () => {
    const changelog = read('packages/client/CHANGELOG.md')
    const v050 = changelog.slice(changelog.indexOf('## 0.5.0'), changelog.indexOf('## 0.4.0'))
    for (const doc of [guide, v050, read('docs/cli.md')]) {
      expect(doc).toContain('`tokens`')
      expect(doc).toContain('`coordinatorTokens`')
    }
  })

  it('is reached from the CLI and MCP guides and from the package README', () => {
    expect(read('docs/cli.md')).toContain('](sdk.md)')
    expect(read('docs/mcp.md')).toContain('](sdk.md)')
    expect(readme).toContain('docs/sdk.md')
  })

  it('is published: docs/ is a gitignore whitelist, and the guide is on it', () => {
    // git check-ignore exits 1 when nothing ignores the path
    let status: unknown = 0
    try {
      execFileSync('git', ['check-ignore', '-q', 'docs/sdk.md'], { cwd: root, stdio: 'ignore' })
    } catch (e) {
      status = (e as { status?: unknown }).status
    }
    expect(status).toBe(1)
  })
})
