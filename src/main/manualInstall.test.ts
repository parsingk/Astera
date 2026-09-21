import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  NOTHING_STAGED,
  extractForManualInstall,
  installRoute,
  manualInstallDir,
  reduceStaging,
  type ManualInstallIO
} from './manualInstall'

const execFileAsync = promisify(execFile)

describe('reduceStaging — Squirrel 이 받은 업데이트를 정말 받아들였는가', () => {
  // electron-updater 는 Squirrel 의 검증이 끝나기 전에 update-downloaded 를 쏜다
  // (MacUpdater.js: dispatchUpdateDownloaded 다음 줄이 nativeUpdater.checkForUpdates 다).
  // 그래서 '받았다' 와 '설치할 수 있다' 는 다른 사실이고, 이 리듀서가 그 둘을 가른다.
  it('다운로드 뒤 스테이징까지 끝나면 거부가 아니다', () => {
    const s = [{ type: 'downloaded' as const }, { type: 'staged' as const }].reduce(
      reduceStaging,
      NOTHING_STAGED
    )
    expect(s.staged).toBe(true)
    expect(s.refused).toBeNull()
  })

  it('다운로드 뒤의 오류는 Squirrel 의 거부로 기록한다', () => {
    const s = [
      { type: 'downloaded' as const },
      { type: 'error' as const, message: 'Code signature ... did not pass validation' }
    ].reduce(reduceStaging, NOTHING_STAGED)
    expect(s.refused).toBe('Code signature ... did not pass validation')
    expect(s.staged).toBe(false)
  })

  it('다운로드 전의 오류는 거부가 아니다 — 피드나 네트워크 문제다', () => {
    const s = reduceStaging(NOTHING_STAGED, { type: 'error', message: 'net::ERR_TIMED_OUT' })
    expect(s.refused).toBeNull()
  })

  it('이미 스테이징된 뒤에 온 오류는 그것을 되돌리지 않는다', () => {
    const s = [
      { type: 'downloaded' as const },
      { type: 'staged' as const },
      { type: 'error' as const, message: '뒤늦은 잡음' }
    ].reduce(reduceStaging, NOTHING_STAGED)
    expect(s.staged).toBe(true)
    expect(s.refused).toBeNull()
  })

  it('새 검사는 판정을 지운다 — 더 새 버전이 앞의 결론을 무효로 만든다', () => {
    const refused = [
      { type: 'downloaded' as const },
      { type: 'error' as const, message: '거부' }
    ].reduce(reduceStaging, NOTHING_STAGED)
    expect(reduceStaging(refused, { type: 'check' })).toEqual(NOTHING_STAGED)
  })
})

describe('installRoute — 설치 버튼이 어느 길로 가는가', () => {
  const refused = { downloaded: true, staged: false, refused: '서명 검증 실패' }
  const staged = { downloaded: true, staged: true, refused: null }

  it('macOS 에서 Squirrel 이 거부했으면 수동 경로다', () => {
    expect(installRoute('darwin', refused)).toBe('manual')
  })

  it('macOS 에서도 정상 스테이징이면 평소의 자동 경로다', () => {
    expect(installRoute('darwin', staged)).toBe('auto')
  })

  it('win32 는 거부가 기록돼도 자동이다 — 이 대체 경로는 macOS 전용이다', () => {
    expect(installRoute('win32', refused)).toBe('auto')
  })
})

describe('manualInstallDir — 어디에 풀어 놓는가', () => {
  it('업데이터가 이미 쓰고 있는 캐시 안, pending 의 형제인 manual/<version> 이다', () => {
    const zip = path.join('/c', 'astera-updater', 'pending', 'Astera-1.3.25-universal-mac.zip')
    expect(manualInstallDir(zip, '1.3.25')).toBe(path.join('/c', 'astera-updater', 'manual', '1.3.25'))
  })
})

/** 호출된 순서를 그대로 적어 두는 IO. 이 함수가 하는 일이 곧 그 순서다. */
function recordingIO(entries: string[]): { calls: string[]; io: ManualInstallIO } {
  const calls: string[] = []
  return {
    calls,
    io: {
      rm: async (dir) => void calls.push(`rm ${dir}`),
      mkdir: async (dir) => void calls.push(`mkdir ${dir}`),
      run: async (file, args) => void calls.push(`${file} ${args.join(' ')}`),
      list: async (dir) => {
        calls.push(`list ${dir}`)
        return entries
      }
    }
  }
}

describe('extractForManualInstall', () => {
  const zip = path.join('/c', 'astera-updater', 'pending', 'Astera-1.3.25-universal-mac.zip')
  const dest = path.join('/c', 'astera-updater', 'manual', '1.3.25')

  it('앞선 시도를 지우고, 풀고, quarantine 을 떼고, .app 을 돌려준다', async () => {
    const { calls, io } = recordingIO(['Astera.app'])
    const app = await extractForManualInstall({ downloadedFile: zip, version: '1.3.25', io })
    expect(app).toBe(path.join(dest, 'Astera.app'))
    expect(calls).toEqual([
      `rm ${dest}`,
      `mkdir ${dest}`,
      `ditto -xk ${zip} ${dest}`,
      // 사람이 터미널에 치던 그 명령. 이 줄이 없으면 quarantine 된 zip 을 푼 결과가
      // 통째로 quarantine 되고, Gatekeeper 가 새 버전의 실행을 막는다.
      `xattr -dr com.apple.quarantine ${dest}`,
      `list ${dest}`
    ])
  })

  it('푼 자리에 .app 이 없으면 조용히 성공하지 않는다', async () => {
    const { io } = recordingIO(['README.txt'])
    await expect(
      extractForManualInstall({ downloadedFile: zip, version: '1.3.25', io })
    ).rejects.toThrow(/\.app/)
  })
})

// 실제 ditto 와 xattr 을 상대로 한 번 돌린다. 위의 순서 테스트는 이 함수가 무엇을 부르는지
// 말해 줄 뿐, 그 부름이 실제로 quarantine 을 떼는지는 말해 주지 못한다 — 그리고 떼어지는가가
// 이 기능의 전부다(측정: quarantine 이 찍힌 zip 을 ditto -xk 로 풀면 속성이 트리 전체로 번진다).
describe.runIf(process.platform === 'darwin')('extractForManualInstall — 진짜 zip 을 상대로', () => {
  it('quarantine 이 찍힌 zip 을 풀어도 결과에는 quarantine 이 남지 않는다', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-manual-install-'))
    const src = path.join(root, 'src')
    await fs.mkdir(path.join(src, 'Astera.app', 'Contents', 'MacOS'), { recursive: true })
    await fs.writeFile(path.join(src, 'Astera.app', 'Contents', 'MacOS', 'Astera'), 'binary')

    const pending = path.join(root, 'astera-updater', 'pending')
    await fs.mkdir(pending, { recursive: true })
    const zip = path.join(pending, 'Astera-9.9.9-universal-mac.zip')
    await execFileAsync('ditto', ['-ck', '--sequesterRsrc', '--keepParent', path.join(src, 'Astera.app'), zip])
    // 브라우저로 받은 zip 이 이렇게 표시된다. 그대로 풀면 속성이 앱 전체로 번진다.
    await execFileAsync('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', zip])

    const app = await extractForManualInstall({ downloadedFile: zip, version: '9.9.9' })

    expect(app).toBe(path.join(root, 'astera-updater', 'manual', '9.9.9', 'Astera.app'))
    await expect(fs.stat(path.join(app, 'Contents', 'MacOS', 'Astera'))).resolves.toBeTruthy()
    const { stdout } = await execFileAsync('xattr', ['-r', '-l', app])
    expect(stdout).not.toMatch(/com\.apple\.quarantine/)
  })
})
