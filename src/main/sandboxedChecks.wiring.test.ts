// Task K: the app runs a Task's checks as the Host does (core/orchestration/exec/validation.ts): every check from the
// environment the Credentials list's hiding leaves (Q5), and a sandboxed Task's inside its workers' sandbox, built by the
// app's session manager (SessionManager.checkLaunch); a sandboxed Claude Task's under srt through Astera's runner, which
// the build bundles and the package keeps where its native helpers can run (Q2). registerIpc and createCore cannot run
// without Electron, so their wiring is guarded by its text, as agentProfiles.wiring.test.ts guards theirs.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SRT_RUNTIME_FILES } from '../core/sandbox/srtCheck'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const start = src.indexOf(from)
  const end = src.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`not found: ${from} … ${to}`)
  return src.slice(start, end)
}

describe("the app's checks of a sandboxed Task", () => {
  it("hands the app's validation the hiding for every check and the session manager's sandboxed launch", () => {
    const wiring = between(read('src/main/ipc.ts'), 'const validation = createTaskValidation({', 'orchValidator = validation.validator')
    expect(wiring).toContain('platform: process.platform')
    expect(wiring).toMatch(/checkEnv: \(cwd\) => core\.sessions\.checkEnv\(process\.env, cwd\)/)
    expect(wiring).toMatch(/sandboxedCheck: async \(a\) => \{[\s\S]*core\.sessions\.checkLaunch\(/)
    // Fix round 2: a check's words name the account by its name
    expect(wiring).toMatch(/accountName: \(id\) => core\.accounts\.list\(\)\.find\(\(x\) => x\.id === id\)\?\.label \?\? null/)
  })

  it('hands the Host’s checks the spawner’s account names', () => {
    expect(read('src/host/drivingWiring.ts')).toMatch(/\.\.\.\(a\.spawner\.accountName \? \{ accountName: a\.spawner\.accountName \} : \{\}\)/)
    expect(read('src/host/checks.ts')).toMatch(/\.\.\.\(d\.accountName \? \{ accountName: d\.accountName \} : \{\}\)/)
  })

  // Fix rounds 1 and 2: the forced sandbox of a reviewer of work a profile's switch sandboxed allows deny rules only where
  // the CLI has none (Claude Code on Windows), as the Host's spawn does; any other forced sandbox there, a reviewer's of a
  // sandboxed session's work included, is still refused (C3)
  it("lets a reviewer's forced sandbox start with deny rules only where the CLI has none", () => {
    const src = read('src/main/ipc.ts')
    expect(src).toMatch(/\.\.\.\(o\.sandboxDenyOnly \? \{ forceSandboxDenyOnly: true \} : \{\}\)/)
    expect(src).toMatch(/if \(forceSandbox && !forceSandboxDenyOnly\) \{\s*const refused = forcedSandboxBlocker/)
  })

  it("gives the app's session manager the srt runner bundled beside the main bundle, off Windows", () => {
    // Fix round 2: only where the runner was built (a runner that is not there would fail as the check's own failure), and
    // the same runner for a Windows Codex check, which tells a sandbox that failed from a check that did
    const core = read('src/main/core.ts')
    expect(core).toMatch(/const checkRunnerPath = paths\?\.sandboxCheck !== undefined && existsSync\(paths\.sandboxCheck\) \? paths\.sandboxCheck : null/)
    expect(core).toMatch(/process\.platform !== 'win32' && checkRunnerPath\) sessions\.checkRunner = srtCheckRunner\(\{ execPath: process\.execPath, runnerPath: checkRunnerPath \}\)/)
    expect(core).toMatch(/if \(checkRunnerPath\) sessions\.codexCheckRunner = codexCheckRunner\(\{ execPath: process\.execPath, runnerPath: checkRunnerPath \}\)/)
    const spawner = read('src/host/spawner.ts')
    expect(spawner).toMatch(/const checkRunnerPath = d\.checkRunnerPath !== undefined && exists\(d\.checkRunnerPath\) \? d\.checkRunnerPath : null/)
    expect(spawner).toMatch(/platform !== 'win32' && checkRunnerPath\) sessions\.checkRunner = srtCheckRunner\(\{ execPath: process\.execPath, runnerPath: checkRunnerPath \}\)/)
    expect(spawner).toMatch(/if \(checkRunnerPath\) sessions\.codexCheckRunner = codexCheckRunner\(\{ execPath: process\.execPath, runnerPath: checkRunnerPath \}\)/)
    expect(read('src/main/index.ts')).toMatch(/createCore\(app\.getPath\('userData'\), app\.getLocale\(\), \{ sandboxCheck: path\.join\(__dirname, 'sandbox-check\.js'\) \}\)/)
    expect(read('electron.vite.config.ts')).toContain("'sandbox-check': 'src/sandboxCheck/index.ts'")
  })

  it('depends on the sandbox runtime at exactly the measured version', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['@anthropic-ai/sandbox-runtime']).toBe('0.0.79')
  })
})

// Fix round 1: a file another process runs or reads (bubblewrap runs srt's seccomp loader; a JVM reads its proxy agent,
// as macOS and Linux run node-pty's spawn-helper) must be a real file, so it is left out of app.asar: electron-builder's
// `asarUnpack`, "glob patterns relative to the app directory, which specifies which files to unpack when creating the
// asar archive" (app-builder-lib 26.15.3, the doc of PlatformSpecificBuildOptions' `asarUnpack`). Its automatic unpacking
// (`smartUnpack`, unpackDetector.js) would catch srt's extension-less binary too, but the jar only by its module, and the
// config does not rest on a heuristic. Read the way electron-builder reads the file (js-yaml, appstreamMetainfo.test.ts).
describe('the package keeps what the sandbox runtime runs out of app.asar', () => {
  const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }
  const config = yaml.load(read('electron-builder.yml')) as { asarUnpack?: string[]; files?: string[] }
  const unpackedBy = (file: string): string[] => (config.asarUnpack ?? []).filter((g) => path.posix.matchesGlob(file, g))
  const excludedBy = (file: string): string[] =>
    (config.files ?? []).filter((g) => g.startsWith('!') && path.posix.matchesGlob(file, g.slice(1)))
  const srt = (f: string): string => `node_modules/@anthropic-ai/sandbox-runtime/${f}`

  it("unpacks every helper srt hands another program, and packs none of them away", () => {
    for (const f of SRT_RUNTIME_FILES) {
      expect(unpackedBy(srt(f)), f).not.toHaveLength(0)
      expect(excludedBy(srt(f)), f).toEqual([])
    }
  })

  it("unpacks node-pty's helpers as before, and leaves srt's Windows helper out of the package", () => {
    expect(unpackedBy('node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')).not.toHaveLength(0)
    // Claude Code has no sandbox on Windows, so srt's Windows helper is never run
    expect(excludedBy(srt('vendor/srt-win/x64/srt-win.exe'))).not.toHaveLength(0)
  })
})
