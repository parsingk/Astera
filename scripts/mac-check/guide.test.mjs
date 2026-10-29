// The Mac check package (scripts/mac-check): the person follows README.md and checklist.md alone at a Mac, with nobody to
// ask, so every file, npm script and app label they name has to exist as written, and run.sh has to run what the guide
// says it runs, within the rules the guide promises (no sudo, no keychain, no model call, no fake-credential measurement).
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ko } from '../../src/core/i18n/messages/ko'
import { en } from '../../src/core/i18n/messages/en'
import { ENFORCE_MIN } from '../../src/core/sessions/cliVersion'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const read = (f) => readFileSync(path.join(here, f), 'utf8')
const guides = { 'README.md': read('README.md'), 'checklist.md': read('checklist.md') }
const runSh = read('run.sh')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
/** run.sh without its comment lines, for what it runs rather than what it says. */
const runCode = runSh
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n')

/** Repository paths a guide names: they start at one of the repository's top folders. */
const repoPaths = (text) => [...new Set([...text.matchAll(/(?<![\w./~$-])((?:src|scripts|docs|resources|packages|\.github)\/[\w.@/-]*[\w])/g)].map((m) => m[1]))]

/** A catalog value matches a label as written when it is the label, its `{placeholders}` standing for any text. A value
 *  with no words of its own (`{detail}`) matches nothing: it would vouch for any label. */
const matches = (template, text) => {
  if (!/\p{L}/u.test(template.replace(/\{\w+\}/g, ''))) return false
  const re = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\w+\\\}/g, '.+')
  return new RegExp(`^${re}$`).test(text)
}
/** The keys whose Korean and English values match a label pair `**한국어** (English)`. */
const keysFor = (koText, enText) => Object.keys(ko).filter((k) => matches(ko[k], koText) && matches(en[k], enText))

describe('scripts/mac-check guides', () => {
  for (const [name, text] of Object.entries(guides)) {
    it(`${name} names only repository files that exist`, () => {
      const missing = repoPaths(text).filter((p) => !existsSync(path.join(root, p)))
      expect(missing).toEqual([])
    })

    it(`${name} names only npm scripts that exist`, () => {
      const runs = [...text.matchAll(/\bnpm run ([\w:-]+)/g)].map((m) => m[1])
      expect(runs.filter((s) => !(s in pkg.scripts))).toEqual([])
      if (/\bnpm ci\b/.test(text)) expect(existsSync(path.join(root, 'package-lock.json'))).toBe(true)
    })

    it(`${name} writes every app label as the app shows it, in Korean and in English`, () => {
      const pairs = [...text.matchAll(/\*\*([^*\n]+)\*\* \(([^)\n]+)\)/g)].map((m) => [m[1], m[2]])
      expect(pairs.length).toBeGreaterThan(0)
      expect(pairs.filter(([k, e]) => keysFor(k, e).length === 0).map(([k, e]) => `${k} (${e})`)).toEqual([])
    })

    it(`${name} runs every astera command on a line of its own, nothing chained to it`, () => {
      // The person's rule: no check of whether a compound or prefixed command escapes Claude's `astera *` exclusion
      const lines = text.split('\n').filter((l) => /(^|[;&|(]\s*|\$\(\s*)astera\s/.test(l.trim()))
      expect(lines.filter((l) => !/^astera [^;&|`$()]+$/.test(l.trim()))).toEqual([])
    })
  }

  it('the README names the CLI versions the sandbox needs, as the code has them', () => {
    expect(guides['README.md']).toContain(`Claude Code ${ENFORCE_MIN.claude}`)
    expect(guides['README.md']).toContain(`Codex ${ENFORCE_MIN.codex}`)
  })

  it('the README names the development profile folder the app takes when unpacked', () => {
    // src/main/index.ts: `app.setPath('userData', app.getPath('userData') + '-dev')` when not packaged
    expect(readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')).toContain("app.setPath('userData', app.getPath('userData') + '-dev')")
    expect(guides['README.md']).toContain(`~/Library/Application Support/${pkg.name}-dev`)
  })

  it('the checklist has the eleven checks, numbered, none left out', () => {
    const numbers = [...guides['checklist.md'].matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]))
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('the checklist holds the block run.sh fills, and run.sh fills that block', () => {
    for (const mark of ['<!-- run.sh summary start -->', '<!-- run.sh summary end -->']) {
      expect(guides['checklist.md']).toContain(mark)
      expect(runSh).toContain(mark)
    }
  })
})

describe('scripts/mac-check/run.sh', () => {
  const testFiles = [...new Set([...runSh.matchAll(/((?:src|scripts)\/[\w./-]+\.test\.(?:ts|mjs))/g)].map((m) => m[1]))]

  it('runs only test files that exist', () => {
    expect(testFiles.length).toBeGreaterThan(0)
    expect(testFiles.filter((f) => !existsSync(path.join(root, f)))).toEqual([])
  })

  it('runs every test file whose real-OS cases run only on macOS', () => {
    const listed = spawnSync('git', ['ls-files', '*.test.ts', '*.test.mjs'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    const darwinOnly = listed.filter((f) => {
      const text = readFileSync(path.join(root, f), 'utf8')
      return /runIf\(process\.platform === 'darwin'\)|process\.platform === 'darwin' && process\.env\.ASTERA_DESKTOP_E2E === '1'/.test(text)
    })
    expect(darwinOnly.length).toBeGreaterThan(0)
    expect(darwinOnly.filter((f) => !testFiles.includes(f))).toEqual([])
  })

  it('checks the CLI versions the sandbox needs, as the code has them', () => {
    expect(runSh).toMatch(new RegExp(`^CLAUDE_MIN=${ENFORCE_MIN.claude.replace(/\./g, '\\.')}\\b`, 'm'))
    expect(runSh).toMatch(new RegExp(`^CODEX_MIN=${ENFORCE_MIN.codex.replace(/\./g, '\\.')}\\b`, 'm'))
  })

  it('reads the Node floor from package.json, which CI and the app share', () => {
    expect(pkg.engines.node).toMatch(/\d+\.\d+\.\d+/)
    expect(runCode).toContain('engines.node')
  })

  it('needs no sudo, never touches the keychain, and never runs the measurement that writes fake credentials', () => {
    expect(runCode).not.toMatch(/\bsudo\b/)
    expect(runCode).not.toMatch(/\bsecurity\b/)
    expect(runCode).not.toMatch(/ASTERA_MEASURE_S2/)
  })

  it('asks Claude Code and Codex only for their version', () => {
    const lines = runCode.split('\n')
    // Run by name nowhere: not at a line's start, after a separator, in a substitution or under `limited`
    expect(lines.filter((l) => /(^\s*|[;&|]\s*|\$\(\s*|limited \d+ )(claude|codex)\b/.test(l))).toEqual([])
    // Run through the loop's variable only with --version
    const runs = lines.filter((l) => /(^\s*|[;&|]\s*|\$\(\s*|limited \d+ )"\$cli"/.test(l))
    expect(runs.length).toBeGreaterThan(0)
    expect(runs.filter((l) => !l.includes('--version'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('is a script bash can read', () => {
    const r = spawnSync('bash', ['-n', path.join(here, 'run.sh')], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
})
