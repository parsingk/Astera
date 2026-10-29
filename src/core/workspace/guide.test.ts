// The guide is the agent's whole reference (resources/skills/app-guide.md): `astera app help` prints
// it and `help('name')` prints one section. So every helper has a section, and the shipped text keeps
// the public docs rule (Global Constraint 11): no dash inside a sentence.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { workspaceHelpers, type HelperDeps } from './helpers'

const skills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../resources/skills')
const read = (f: string): string => readFileSync(path.join(skills, f), 'utf8')

/** Prose lines only: fenced code, headings, front matter and the stub marker comment are left out. */
const prose = (text: string): string[] => {
  const out: string[] = []
  let fenced = false
  let comment = false
  let front = text.startsWith('---')
  for (const [i, line] of text.split('\n').entries()) {
    if (front) {
      if (i > 0 && line === '---') front = false
      continue
    }
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (line.includes('<!--')) comment = true
    if (!fenced && !comment && !line.startsWith('#')) out.push(line)
    if (line.includes('-->')) comment = false
  }
  return out
}

describe('app-guide.md', () => {
  it('has a section for every helper the script sees', () => {
    const guide = read('app-guide.md')
    const names = Object.keys(workspaceHelpers({} as HelperDeps, { at: 'script' }))
    for (const name of names) expect(guide, name).toMatch(new RegExp(`^## ${name}\\(`, 'm'))
  })

  it('keeps no dash inside a sentence, in the guide or the stub', () => {
    for (const file of ['app-guide.md', 'app-stub.md'])
      for (const line of prose(read(file))) expect(line, `${file}: ${line}`).not.toMatch(/\S\s[—–-]\s\S/)
  })

  it('tells each platform how to pass the port, and what macOS and Linux do differently', () => {
    const guide = read('app-guide.md')
    expect(guide).toContain('%ASTERA_APP_CDP_PORT%')
    expect(guide).toContain('$ASTERA_APP_CDP_PORT')
    expect(guide).toContain('$ASTERA_APP_CHROMIUM_FLAGS')
    expect(guide).toContain('not available on macOS')
    expect(guide).toContain('`className` is empty on Linux')
    expect(guide).not.toContain('a Windows desktop the person never sees')
    const stub = read('app-stub.md')
    expect(stub).not.toContain('on a Windows desktop the person never sees')
    expect(stub).toContain('$ASTERA_APP_CDP_PORT')
  })

  // The 2026-10-29 Mac check: the agent drove the dev app's main process over --inspect, and app.quit()
  // left the process up, deaf to one SIGTERM, until SIGKILL. Node's exit waits for every inspector
  // client to leave (inspector_agent.cc, Agent::WaitForDisconnect); close() ends the app regardless.
  it('says that an open inspector connection keeps the app running after a quit, and that close() ends it', () => {
    const rule = read('app-guide.md')
      .split('\n- ')
      .find((b) => b.startsWith('**Ending the app.**'))
    expect(rule).toBeDefined()
    expect(rule).toContain('`--inspect`')
    expect(rule).toContain('`Waiting for the debugger to disconnect...`')
    expect(rule).toContain('one SIGTERM')
    expect(rule).toContain('`close()`')
  })
})
