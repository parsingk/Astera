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
import { ENFORCE_MIN, USE_REPORT_MIN_CLAUDE } from '../../src/core/sessions/cliVersion'
import * as securityText from '../../src/renderer/src/components/securityText'

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

/** The checklist's numbered checks, each with its title and its text up to the next `## ` heading. */
const checks = (() => {
  const text = guides['checklist.md']
  return [...text.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => {
    const end = text.indexOf('\n## ', m.index + 1)
    return { n: Number(m[1]), title: m[2].trim(), body: text.slice(m.index, end < 0 ? undefined : end) }
  })
})()
/** Who can do a check (the brief of round 2): an agent too, or only a person at the Mac. */
const WHO = ['에이전트도', '사람만']
const whoLines = (body) => [...body.matchAll(/^누가: (\S+)/gm)].map((m) => m[1])

/** The names Settings › Security & Access keeps in English in every language (securityText.ts). */
const englishNames = Object.values(securityText).filter((v) => typeof v === 'string')

/** Repository paths a guide names: they start at one of the repository's top folders. */
const repoPaths = (text) => [...new Set([...text.matchAll(/(?<![\w./~$-])((?:src|scripts|docs|resources|packages|\.github)\/[\w.@/-]*[\w])/g)].map((m) => m[1]))]
/** The person's own two-computer checklist, which checks 28 and 30 point to: kept out of git on purpose, so it is on
 *  their disk and nowhere else. The guides may name it only while git ignores it. */
const LOCAL_ONLY = 'docs/remote-runtime-checks.md'
const ignored = (p) => spawnSync('git', ['check-ignore', '-q', p], { cwd: root }).status === 0

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
      const missing = repoPaths(text).filter((p) => !existsSync(path.join(root, p)) && !(p === LOCAL_ONLY && ignored(p)))
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
      // A pair broken over two lines would be checked by neither this test nor the English-only one
      expect([...text.matchAll(/\*\*([^*\n]+)\*\* \(/g)].length).toBe(pairs.length)
      expect(pairs.filter(([k, e]) => keysFor(k, e).length === 0).map(([k, e]) => `${k} (${e})`)).toEqual([])
    })

    it(`${name} writes every English-only app name as the app shows it`, () => {
      // A bold name with no `(English)` after it is one the app shows the same in every language: a section of Security &
      // Access, or a catalog value that is the same in Korean and English (`MCP & Skills`, `Findings {count}`)
      const alone = [...text.matchAll(/\*\*([^*\n]+)\*\*( \()?/g)]
        .filter((m) => m[2] === undefined)
        .map((m) => m[1])
        .filter((s) => /^[\x20-\x7e]+$/.test(s) && /[A-Za-z]/.test(s))
      const known = (s) => englishNames.includes(s) || Object.keys(ko).some((k) => ko[k] === en[k] && matches(en[k], s))
      expect(alone.filter((s) => !known(s))).toEqual([])
    })

    it(`${name} runs only package binaries this checkout installs`, () => {
      const bins = [...new Set([...text.matchAll(/\.\/node_modules\/\.bin\/([\w-]+)/g)].map((m) => m[1]))]
      expect(bins.filter((b) => !existsSync(path.join(root, 'node_modules', '.bin', b)))).toEqual([])
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

  it('the README names the Claude Code that reports skill uses, as the code has it', () => {
    expect(guides['README.md']).toContain(`Claude Code ${USE_REPORT_MIN_CLAUDE}`)
  })

  it("the checklist numbers its checks from 1, none left out: round 1's eleven and round 2's from 12 on", () => {
    // A later round appends after the last one, so only the floor is fixed here
    const numbers = checks.map((c) => c.n)
    expect(numbers).toEqual(numbers.map((_, i) => i + 1))
    expect(numbers.length).toBeGreaterThanOrEqual(25)
  })

  it('every check says once who can do it, and ends with a box to tick', () => {
    for (const c of checks) {
      expect(whoLines(c.body), `${c.n}. ${c.title}`).toHaveLength(1)
      expect(WHO, `${c.n}. ${c.title}`).toContain(whoLines(c.body)[0])
      expect(c.body, `${c.n}. ${c.title}`).toMatch(/^- \[ \] /m)
    }
  })

  it('the README lists every check with who can do it, as the checklist has them', () => {
    const rows = [...guides['README.md'].matchAll(/^\| (\d+) \| (.+?) \| (\S+) \|/gm)].map((m) => ({ n: Number(m[1]), title: m[2], who: m[3] }))
    expect(rows).toEqual(checks.map((c) => ({ n: c.n, title: c.title, who: whoLines(c.body)[0] })))
  })

  it("check 25 saves and puts back the installed astera command a packaged build's start rewrites", () => {
    // A packaged start points an installed public shuttle at itself (src/main/ipc.ts, the boot sync), in a folder that
    // depends on neither the profile nor the product name (cliInstall.ts binDirFor), so the rename cannot keep it away
    const ipc = readFileSync(path.join(root, 'src/main/ipc.ts'), 'utf8')
    const install = readFileSync(path.join(root, 'src/core/orchestration/cliInstall.ts'), 'utf8')
    const packaged = checks.find((c) => c.title === '패키지한 앱')
    expect(packaged).toBeDefined()
    // Asserted, not a condition: a change to the boot sync fails here, so someone looks at check 25 again
    expect(ipc).toContain('void syncShuttle(')
    expect(install).toContain('return `${a.home}/.local/bin`')
    const body = packaged.body
    // The file's own two lines and nothing before them, as step 9 prints them
    expect(body).toContain('[ -f ~/.local/bin/astera ] && head -n 2 ~/.local/bin/astera && cp -p ~/.local/bin/astera "$R/astera-cli.before"')
    expect(body).toContain('cmp -s "$R/astera-cli.before" ~/.local/bin/astera || cp -p "$R/astera-cli.before" ~/.local/bin/astera')
    // Put back before the build it points at is removed
    expect(body.indexOf('cmp -s "$R/astera-cli.before"')).toBeLessThan(body.indexOf('rm -rf "$R/packaged"'))
    expect(guides['README.md']).toContain('~/.local/bin/astera')
  })

  it("check 25 gives the agent an inspector for the packaged build's folder picker, closed before the quit", () => {
    // The New session dialog's folder comes only from the native picker, which an agent answers by replacing
    // dialog.showOpenDialog over the main process inspector (세션을 여는 법); an open inspector keeps the app up at quit
    const body = checks.find((c) => c.title === '패키지한 앱').body
    // One step's text, its line breaks read as the spaces they stand for
    const step = (n) => body.slice(body.indexOf(`\n${n}. `), body.indexOf(`\n${n + 1}. `)).replace(/\s+/g, ' ')
    expect(step(4)).toContain('--inspect')
    expect(step(4)).toContain('dialog.showOpenDialog')
    expect(step(4)).toContain('8단계에서 끄기 전에 그 inspector 연결을 닫습니다')
    // Step 8 closes the connection step 6 opened, in its text before the quit
    const quit = step(8)
    expect(quit).toContain('window.api.app.quit()')
    expect(quit.slice(0, quit.indexOf('window.api.app.quit()'))).toContain('6단계에서 연 inspector 연결을 먼저 닫고')
  })

  it('check 24 hands the Chromium switches to Electron after a second --, where electron-vite does not read them', () => {
    // electron-vite's dev command refuses an option it does not declare (no allowUnknownOptions) and hands what follows
    // `--` to Electron; npm passes the second `--` on to the script
    const ev = readFileSync(path.join(root, 'node_modules/electron-vite/dist/cli.js'), 'utf8')
    expect(ev).not.toContain('allowUnknownOptions')
    expect(ev).toContain("process.env.ELECTRON_CLI_ARGS = JSON.stringify(options['--'])")
    const body = checks.find((c) => c.title === 'inspector 를 켜고 띄운 개발용 앱 끄기').body
    expect(body).toContain('npm run dev -- --inspect --remoteDebuggingPort $ASTERA_APP_CDP_PORT -- $ASTERA_APP_CHROMIUM_FLAGS > <결과 폴더>/inspect-dev.log 2>&1')
  })

  it('the wrap-up looks for what check 12 left in imported account folders too', () => {
    const text = guides['checklist.md']
    const wrapUp = text.slice(text.indexOf('\n## 마무리'))
    for (const folder of ['~/.claude-accounts', '~/.codex-accounts', '<폴더>/.claude.json']) expect(wrapUp).toContain(folder)
  })

  it('the packaged build is signed ad hoc as the release workflow signs it, under a name and id of its own', () => {
    const release = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
    const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
    const line = guides['checklist.md'].split('\n').find((l) => l.includes('electron-builder --mac'))
    expect(line).toBeDefined()
    for (const flag of ['-c.mac.notarize=false', '-c.mac.identity=-']) {
      expect(release).toContain(flag)
      expect(line).toContain(flag)
    }
    expect(release).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(guides['checklist.md']).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false')
    // Electron names the profile folder after the packaged package.json's productName (app.getName), so a build under
    // the release's name could open the installed Astera's profile
    const productName = /-c\.productName=(\w+)/.exec(line)?.[1]
    const appId = /-c\.appId=([\w.]+)/.exec(line)?.[1]
    expect(productName).toBeDefined()
    expect(productName).not.toBe(/^productName: (\S+)/m.exec(builder)?.[1])
    expect(line).toContain(`-c.extraMetadata.productName=${productName}`)
    expect(appId).toBeDefined()
    expect(appId).not.toBe(/^appId: (\S+)/m.exec(builder)?.[1])
  })

  // Control Plane Phase 12 (remote governance design §13): one Mac pairs the dev app, as controller, with a Runtime on a
  // profile of its own inside the results folder. What needs two computers stays in the person's two-computer checklist.
  const phase12 = (n) => checks.find((c) => c.n === n)

  it('checks 26 to 30 are the Phase 12 checks, after 25 and before the wrap-up', () => {
    const text = guides['checklist.md']
    const words = ['연결', '자세히', 'Finding', 'MCP', '해제']
    words.forEach((w, i) => expect(phase12(26 + i)?.title, `check ${26 + i}`).toContain(w))
    expect(text.indexOf('\n## 26. ')).toBeGreaterThan(text.indexOf('\n## 25. '))
    expect(text.indexOf('\n## 30. ')).toBeLessThan(text.indexOf('\n## 마무리'))
  })

  it('check 26 confirms one Mac can pair with itself before anything else, on a Runtime profile of its own', () => {
    const body = phase12(26).body
    for (const verb of ['host start', 'runtime start', 'runtime pair']) {
      expect(body).toContain(`"$R/runtime-astera" ${verb}`)
      expect(body).not.toContain(`"$R/dev-astera" ${verb}`)
    }
    expect(body).toContain('--listen 127.0.0.1 --port 47900')
    expect(body).toContain('--full-control')
  })

  it('names a Runtime to the CLI with --id, the one way runtimes get, ping and expect take it', () => {
    // A command, not a verb named in a sentence (`runtimes get` 의 출력): the verb with something after it
    const uses = Object.values(guides).flatMap((text) => [...text.matchAll(/runtimes (?:get|ping|expect) (\S+)/g)])
    expect(uses.length).toBeGreaterThan(0)
    expect(uses.filter((m) => m[1] !== '--id').map((m) => m[0])).toEqual([])
  })

  it('check 27 takes either surface the controller last signed in with, since the record keeps only the last', () => {
    // host/controllers.ts ControllerRecord.surface: what the client said at its last sign-in. Check 26 asks from the app
    // and then the CLI, and the app keeps its connection open for a while, so which came last is not fixed
    const body = phase12(27).body
    expect(body).toContain('`"surface":"desktop"` 이거나 `"surface":"cli"`')
  })

  it('check 28 clears the finding from this computer and sees it gone at the next read, with no wait for a cache', () => {
    // A fresh runtimes.json reaches Findings at the next request (plan ruling 11, changed 2026-11-01)
    const body = phase12(28).body
    expect(body).toContain('runtimes expect --id mac-check-runtime --remove skill-mac-check-skill')
    expect(body).toContain('runtime-missing-extension')
    expect(body).not.toMatch(/1분|a minute/)
  })

  it('check 29 runs an agent-classified CLI and expects RUNTIME_PERMISSION_DENIED', () => {
    // The CLI tells the Runtime it is an agent's from ASTERA_SESSION (cli/run.ts), which both helpers clear
    expect(readFileSync(path.join(root, 'src/cli/run.ts'), 'utf8')).toContain("const inAgentSession = (process.env.ASTERA_SESSION ?? '') !== ''")
    const body = phase12(29).body
    const line = body.split('\n').find((l) => l.includes('ASTERA_SESSION=mac-check'))
    expect(line).toBeDefined()
    expect(line).not.toMatch(/dev-astera|runtime-astera/)
    expect(line).toContain('ASTERA_PROFILE_DIR="$HOME/Library/Application Support/astera-dev"')
    expect(line).toContain('out/main/cli.js runtimes get --id mac-check-runtime')
    // Every other session variable the helpers clear is cleared here too, so only ASTERA_SESSION speaks for an agent
    const devLine = runCode.split('\n').find((l) => l.includes('exec env') && l.includes('astera-dev'))
    const others = [...devLine.matchAll(/-u (\w+)/g)].map((m) => m[1]).filter((v) => v !== 'ASTERA_SESSION')
    expect(others.length).toBeGreaterThan(0)
    expect(others.filter((v) => !line.includes(`-u ${v} `))).toEqual([])
    expect(line).not.toContain('-u ASTERA_SESSION')
    expect(body).toContain('RUNTIME_PERMISSION_DENIED')
    // MCP has no tool that asks for the report (design §10.3); its case is an e2e test
    expect(body).toContain('get_runtime')
  })

  it('check 30 unpairs from the Runtime, which paused nothing, and the controller is then refused as unpaired', () => {
    const body = phase12(30).body
    const name = 'mac-check-dev'
    expect(body).toContain('"$R/runtime-astera" runtime revoke --id')
    expect(body).toContain(ko['settings.remote.revoke.done'].replace('{name}', name))
    expect(body).toContain(en['settings.remote.revoke.done'].replace('{name}', name))
    // With no scheduled Job there, the line that names counts is not the one shown
    expect(body).not.toContain(ko['settings.remote.revoke.paused'].split('{paused}')[0].replace('{name}', name))
    expect(body).toContain(ko['settings.remote.link.authFailed'])
    expect(body).toContain('RUNTIME_AUTH_FAILED')
  })

  it('checks 28 and 30 end by pointing to the two-computer checklist for what one Mac cannot show', () => {
    expect(ignored(LOCAL_ONLY)).toBe(true)
    for (const [n, part] of [[28, '3-3'], [30, '3-6']]) {
      const body = phase12(n).body
      const pointer = body.slice(body.lastIndexOf('- [ ] 실패'))
      expect(pointer, `check ${n}`).toContain(`\`${LOCAL_ONLY}\``)
      expect(pointer, `check ${n}`).toContain(part)
    }
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

  it('notes the Claude Code that reports skill uses, as the code has it', () => {
    expect(runSh).toMatch(new RegExp(`^USE_MIN=${USE_REPORT_MIN_CLAUDE.replace(/\./g, '\\.')}\\b`, 'm'))
  })

  it('writes every work-folder file and helper the checklist uses', () => {
    const text = guides['checklist.md']
    const named = new Set([...text.matchAll(/mac-check-app\/[\w.-]+\.\w+/g)].map((m) => m[0]))
    for (const helper of ['dev-astera', 'runtime-astera', 'env.sh', 'ext/mac-check-skill']) {
      expect(text).toContain(helper)
      named.add(helper)
    }
    expect([...named].filter((f) => !runSh.includes(f))).toEqual([])
  })

  it('writes into the scratch repository the npm script the checklist picks as a completion check', () => {
    expect(guides['checklist.md']).toContain('+ mac-check-sandbox')
    expect(runSh).toMatch(/^ {4}"mac-check-sandbox": "/m)
  })

  it("points its helper CLI at the development app's profile folder, never the installed one", () => {
    expect(runCode).toContain(`Application Support/${pkg.name}-dev`)
    expect(runCode).toMatch(/ASTERA_PROFILE_DIR=/)
  })

  it("writes runtime-astera beside dev-astera, on a profile folder inside the results folder, clearing the session's variables", () => {
    // Each helper's exec line, told apart by the profile folder it names
    const unset = (profile) => {
      const line = runCode.split('\n').find((l) => l.includes('exec env') && l.includes(`ASTERA_PROFILE_DIR=${profile}`))
      return line === undefined ? null : [...line.matchAll(/-u (\w+)/g)].map((m) => m[1])
    }
    const dev = unset('\\"\\$HOME/Library/Application Support/astera-dev\\"')
    const runtime = unset('$(sq "$R/runtime-profile")')
    expect(runCode).toContain('> "$R/runtime-astera"')
    expect(dev).toContain('ASTERA_SESSION')
    expect(runtime).toEqual(dev)
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
