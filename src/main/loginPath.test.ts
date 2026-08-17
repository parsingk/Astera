// PATH 복구 프로브가 어느 플랫폼에서 실제로 도는지 고정하는 검사.
//
// 왜 필요한가: .desktop 런처로 띄운 Linux 앱은 ~/.bashrc·~/.zshrc 를 거치지 않아, nvm 이나
// ~/.local/bin 에 설치된 claude·codex 가 PATH 에 아예 없다. 그 상태에서는 system.checkCli 가 둘 다
// ok:false 로 돌려주고 앱은 "No CLI found to run" 화면에서 더 나아가지 못한다. 이 결함은 손으로
// 확인할 수 없다 — 터미널에서 앱을 실행하면 부모 셸의 PATH 를 그대로 물려받아 프로브가 없어도
// 통과하기 때문이다. 그래서 플랫폼 분기의 증거는 이 검사뿐이다.
import { describe, it, expect } from 'vitest'
import { readLoginPath } from './loginPath'

/** 프로브 출력의 모양 — 마커 사이에 PATH 를 끼운 것 */
const probeOutput = (p: string): string => `__ASTERA_PATH__${p}__END__`

/** run 호출을 기록하는 스텁. 셸이 실제로 떴는지, 어떤 셸에 어떤 플래그로 떴는지를 본다 */
function recorder(stdout: string): {
  calls: { file: string; args: string[] }[]
  run: (file: string, args: string[]) => Promise<string>
} {
  const calls: { file: string; args: string[] }[] = []
  return {
    calls,
    run: async (file, args) => {
      calls.push({ file, args })
      return stdout
    }
  }
}

describe('readLoginPath — 로그인 셸 PATH 프로브', () => {
  it('linux: 로그인 셸에 PATH 를 물어본다', async () => {
    const rec = recorder(probeOutput('/home/u/.nvm/versions/node/v22/bin:/usr/bin'))
    const got = await readLoginPath({ platform: 'linux', shell: '/bin/bash', run: rec.run })
    expect(got).toBe('/home/u/.nvm/versions/node/v22/bin:/usr/bin')
    // -i 가 빠지면 nvm 을 초기화하는 ~/.bashrc 를 읽지 않아 프로브가 아무 소용이 없다
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0].file).toBe('/bin/bash')
    expect(rec.calls[0].args[0]).toBe('-ilc')
  })

  it('linux: SHELL 이 비어 있으면 /bin/sh 로 띄운다 — POSIX 가 존재를 보장하는 유일한 셸이다', async () => {
    const rec = recorder(probeOutput('/usr/local/bin:/usr/bin'))
    const got = await readLoginPath({ platform: 'linux', shell: undefined, run: rec.run })
    expect(got).toBe('/usr/local/bin:/usr/bin')
    expect(rec.calls[0].file).toBe('/bin/sh')
  })

  it('darwin: 기존 동작 그대로 — SHELL 을 쓰고 없으면 /bin/zsh', async () => {
    const withShell = recorder(probeOutput('/opt/homebrew/bin:/usr/bin'))
    expect(await readLoginPath({ platform: 'darwin', shell: '/bin/zsh', run: withShell.run })).toBe(
      '/opt/homebrew/bin:/usr/bin'
    )
    expect(withShell.calls[0]).toEqual({ file: '/bin/zsh', args: ['-ilc', expect.any(String)] })
    const noShell = recorder(probeOutput('/usr/bin'))
    await readLoginPath({ platform: 'darwin', shell: '', run: noShell.run })
    expect(noShell.calls[0].file).toBe('/bin/zsh')
  })

  it('win32: 셸을 띄우지 않는다 — PATH 는 환경 변수라 GUI 앱도 그대로 물려받는다', async () => {
    const rec = recorder(probeOutput('/never'))
    expect(await readLoginPath({ platform: 'win32', shell: undefined, run: rec.run })).toBeNull()
    expect(rec.calls).toHaveLength(0)
  })

  it('프로브가 실패하면 null — 앱 시작을 막지 않는다', async () => {
    const got = await readLoginPath({
      platform: 'linux',
      shell: '/bin/bash',
      run: () => Promise.reject(new Error('spawn failed'))
    })
    expect(got).toBeNull()
  })

  it('마커가 없으면 null — 셸이 무엇을 찍었든 PATH 로 오해하지 않는다', async () => {
    const rec = recorder('bash: cannot set terminal process group\n')
    expect(await readLoginPath({ platform: 'linux', shell: '/bin/bash', run: rec.run })).toBeNull()
  })
})
