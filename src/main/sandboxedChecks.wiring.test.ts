// Task K: the app runs a Task's checks as the Host does (core/orchestration/exec/validation.ts): every check from the
// environment the Credentials list's hiding leaves (Q5), and a sandboxed Task's inside its workers' sandbox, built by the
// app's session manager (SessionManager.checkLaunch); a sandboxed Claude Task's under srt through Astera's runner, which
// the build bundles and the package keeps where its native helpers can run (Q2). registerIpc and createCore cannot run
// without Electron, so their wiring is guarded by its text, as agentProfiles.wiring.test.ts guards theirs.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  })

  it("gives the app's session manager the srt runner bundled beside the main bundle, off Windows", () => {
    expect(read('src/main/core.ts')).toMatch(/process\.platform !== 'win32' && paths\?\.sandboxCheck\) sessions\.checkRunner = srtCheckRunner\(/)
    expect(read('src/main/index.ts')).toMatch(/createCore\(app\.getPath\('userData'\), app\.getLocale\(\), \{ sandboxCheck: path\.join\(__dirname, 'sandbox-check\.js'\) \}\)/)
    expect(read('electron.vite.config.ts')).toContain("'sandbox-check': 'src/sandboxCheck/index.ts'")
  })

  it('depends on the sandbox runtime at exactly the measured version, unpacked where its helpers can run', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['@anthropic-ai/sandbox-runtime']).toBe('0.0.79')
    const builder = read('electron-builder.yml')
    expect(builder).toContain("'**/node_modules/@anthropic-ai/sandbox-runtime/**'")
    // Its Windows helper is never used: Claude Code has no sandbox on Windows
    expect(builder).toContain("'!**/node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/**'")
  })
})
