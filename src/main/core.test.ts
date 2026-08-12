import { describe, it, expect, vi, afterEach } from 'vitest'
import path from 'node:path'
import { runAccountLogout } from './core'
import { makeDescriptors } from '../core/providers/descriptor'

// 실제 홈 경로를 쓰지 않는다 — runAccountLogout이 homeDir을 명시 인자로 받으므로 os.homedir()에
// 기대지 않고도 ambient/격리 케이스를 자유롭게 구성할 수 있다(manager.test.ts·descriptor.test.ts와
// 같은 가짜 Windows 경로 관례).
const homeDir = path.join('C:', 'Users', 'tester')
const descriptors = makeDescriptors('win32')

interface Captured {
  file: string
  args: string[]
  options: { env: NodeJS.ProcessEnv; shell: boolean; timeout: number }
}

/** execFileFn을 스텁으로 갈아끼워 core.ts가 실제로 넘기는 file/args/env를 그대로 잡아낸다. */
function capturingExecFile(result: { err: Error | null; stdout?: string; stderr?: string } = { err: null }) {
  let captured: Captured | undefined
  const execFileFn = (
    file: string,
    args: string[],
    options: Captured['options'],
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): void => {
    captured = { file, args, options }
    callback(result.err, result.stdout ?? '', result.stderr ?? '')
  }
  return { execFileFn, get captured() { return captured } }
}

/**
 * 이 파일의 env 단정은 상속 환경을 그대로 두면 성립하지 않는다.
 *
 * runAccountLogout은 `{ ...process.env }`로 시작해 자기 provider의 변수만 만진다(core.ts). 그래서
 * 단정이 실행 환경에 따라 두 방향으로 어긋난다:
 *  - 상대 provider 변수(`in env === false`)는 그 변수가 환경에 있으면 **항상 실패**한다. Opus가 띄운
 *    세션은 계정 격리로 CLAUDE_CONFIG_DIR을 심으므로, 앱 안에서 테스트를 돌리면 늘 빨간불이었다.
 *  - ambient의 삭제 단정은 그 변수가 환경에 **없으면 무조건 통과**한다 — core.ts의 delete 줄을 지워도
 *    초록불이라 회귀를 잡지 못했다. CI에는 그 변수가 없어 이 구멍이 드러나지 않았다.
 *
 * 그래서 각 테스트가 상속 환경을 vi.stubEnv로 직접 세우고, "심었을 때 어떻게 되는지"까지 본다.
 */
const INHERITED_CLAUDE = path.join('D:', 'inherited', 'claude-config')
const INHERITED_CODEX = path.join('D:', 'inherited', 'codex-home')

describe('runAccountLogout 배선', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('claude·codex × ambient·격리 4조합', () => {
    it('claude ambient(<home>/.claude): file=claude, args=[auth,logout], CLAUDE_CONFIG_DIR 미주입', async () => {
      // 상속 환경에 값이 있어도 지워야 한다 — 남으면 ambient 로그아웃이 격리 계정 설정을 향한다.
      // 심지 않고 보면 core.ts의 delete 줄이 없어도 통과한다(파일 상단 주석).
      vi.stubEnv('CLAUDE_CONFIG_DIR', INHERITED_CLAUDE)
      const stub = capturingExecFile()
      const configDir = path.join(homeDir, '.claude')
      const result = await runAccountLogout(descriptors.claude, homeDir, configDir, stub.execFileFn)
      expect(stub.captured?.file).toBe('claude')
      expect(stub.captured?.args).toEqual(['auth', 'logout'])
      expect('CLAUDE_CONFIG_DIR' in stub.captured!.options.env).toBe(false)
      expect(result).toEqual({ ok: true })
    })

    it('claude 격리(<home>/.claude-accounts/work): CLAUDE_CONFIG_DIR을 configDir로 주입', async () => {
      const stub = capturingExecFile()
      const configDir = path.join(homeDir, '.claude-accounts', 'work')
      await runAccountLogout(descriptors.claude, homeDir, configDir, stub.execFileFn)
      expect(stub.captured?.file).toBe('claude')
      expect(stub.captured?.args).toEqual(['auth', 'logout'])
      expect(stub.captured?.options.env.CLAUDE_CONFIG_DIR).toBe(configDir)
    })

    it('codex ambient(<home>/.codex): file=codex, args=[logout], CODEX_HOME 미주입', async () => {
      // ambient는 상속값을 지워야 한다 (위 claude ambient와 같은 이유)
      vi.stubEnv('CODEX_HOME', INHERITED_CODEX)
      const stub = capturingExecFile()
      const configDir = path.join(homeDir, '.codex')
      const result = await runAccountLogout(descriptors.codex, homeDir, configDir, stub.execFileFn)
      expect(stub.captured?.file).toBe('codex')
      expect(stub.captured?.args).toEqual(['logout'])
      expect('CODEX_HOME' in stub.captured!.options.env).toBe(false)
      expect(result).toEqual({ ok: true })
    })

    it('codex 격리(<home>/.codex-accounts/work): CODEX_HOME을 configDir로 주입', async () => {
      const stub = capturingExecFile()
      const configDir = path.join(homeDir, '.codex-accounts', 'work')
      await runAccountLogout(descriptors.codex, homeDir, configDir, stub.execFileFn)
      expect(stub.captured?.file).toBe('codex')
      expect(stub.captured?.args).toEqual(['logout'])
      expect(stub.captured?.options.env.CODEX_HOME).toBe(configDir)
    })
  })

  // 배선이 틀리면 격리 계정 로그아웃이 기본 계정의 자격증명을 지울 수 있다 — provider는
  // 자기 환경변수만 만져야 하고 상대 provider의 변수는 건드리면(주입도 삭제도) 안 된다.
  it('codex 로그아웃(격리)은 CLAUDE_CONFIG_DIR을 만들지도 지우지도 않는다', async () => {
    const configDir = path.join(homeDir, '.codex-accounts', 'work')
    // 상속 환경에 없으면 만들지 않는다
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
    const clean = capturingExecFile()
    await runAccountLogout(descriptors.codex, homeDir, configDir, clean.execFileFn)
    expect('CLAUDE_CONFIG_DIR' in clean.captured!.options.env).toBe(false)
    // 있으면 그 값을 그대로 통과시킨다 — 지우면 기본 계정 자격증명을 향하게 된다.
    // 종전에는 이 갈래가 없어서, 환경에 값이 있는 채로 돌리면(앱이 띄운 세션) 위 단정이 늘 실패했다.
    vi.stubEnv('CLAUDE_CONFIG_DIR', INHERITED_CLAUDE)
    const inherited = capturingExecFile()
    await runAccountLogout(descriptors.codex, homeDir, configDir, inherited.execFileFn)
    expect(inherited.captured!.options.env.CLAUDE_CONFIG_DIR).toBe(INHERITED_CLAUDE)
  })

  it('claude 로그아웃(격리)은 CODEX_HOME을 만들지도 지우지도 않는다', async () => {
    const configDir = path.join(homeDir, '.claude-accounts', 'work')
    vi.stubEnv('CODEX_HOME', undefined)
    const clean = capturingExecFile()
    await runAccountLogout(descriptors.claude, homeDir, configDir, clean.execFileFn)
    expect('CODEX_HOME' in clean.captured!.options.env).toBe(false)
    // codex 계정으로 띄운 세션 안에서 돌리면 CODEX_HOME이 상속된다 — 그때도 손대지 않아야 한다
    vi.stubEnv('CODEX_HOME', INHERITED_CODEX)
    const inherited = capturingExecFile()
    await runAccountLogout(descriptors.claude, homeDir, configDir, inherited.execFileFn)
    expect(inherited.captured!.options.env.CODEX_HOME).toBe(INHERITED_CODEX)
  })

  describe('실패 경로', () => {
    it('execFile 에러 + stderr 있음 → account.error.raw에 stderr를 detail로 담는다', async () => {
      const stub = capturingExecFile({ err: new Error('exit 1'), stderr: '  not logged in  ' })
      const result = await runAccountLogout(
        descriptors.claude,
        homeDir,
        path.join(homeDir, '.claude'),
        stub.execFileFn
      )
      expect(result).toEqual({
        ok: false,
        message: { key: 'account.error.raw', params: { detail: 'not logged in' } }
      })
    })

    it('execFile 에러 + stderr 없음 → err.message를 detail로 쓴다', async () => {
      const stub = capturingExecFile({ err: new Error('spawn ENOENT'), stderr: '' })
      const result = await runAccountLogout(
        descriptors.codex,
        homeDir,
        path.join(homeDir, '.codex'),
        stub.execFileFn
      )
      expect(result).toEqual({
        ok: false,
        message: { key: 'account.error.raw', params: { detail: 'spawn ENOENT' } }
      })
    })

    it('execFile 에러인데 stderr·message 둘 다 비어있으면 account.error.logoutFailed', async () => {
      const stub = capturingExecFile({ err: new Error(''), stderr: '' })
      const result = await runAccountLogout(
        descriptors.claude,
        homeDir,
        path.join(homeDir, '.claude'),
        stub.execFileFn
      )
      expect(result).toEqual({ ok: false, message: { key: 'account.error.logoutFailed' } })
    })

    it('execFile 성공이면 message 없이 ok:true만 돌려준다', async () => {
      const stub = capturingExecFile()
      const result = await runAccountLogout(
        descriptors.claude,
        homeDir,
        path.join(homeDir, '.claude'),
        stub.execFileFn
      )
      expect(result).toEqual({ ok: true })
    })
  })
})
