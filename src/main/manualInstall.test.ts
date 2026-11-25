import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  NOTHING_STAGED,
  extractForManualInstall,
  installCopyToApplications,
  installRoute,
  manualInstallCopyOf,
  manualInstallDir,
  reduceStaging,
  type CopyInstallIO,
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

// 이 함수는 Electron 의 main 프로세스에서 돈다. 그곳의 `fs` 는 .asar 파일을 디렉터리처럼 보이게
// 패치돼 있어서, fs.rm(recursive) 가 풀어 둔 앱의 Contents/Resources/app.asar 를 지우지 못하고
// `ENOTEMPTY: directory not empty, rmdir '…/Contents/Resources'` 로 끝난다(1.5.5 에서 측정:
// 같은 버전을 두 번째로 누르면 매번 실패). vitest 의 Node 에는 그 패치가 없으니 진짜 Electron 을
// node 모드로 띄워서 지운다.
const electronBinary = (() => {
  try {
    return createRequire(import.meta.url)('electron') as string
  } catch {
    return null
  }
})()

describe.runIf(process.platform === 'darwin' && electronBinary !== null)(
  'nodeManualInstallIO.rm — Electron 안에서',
  () => {
    it('app.asar 가 든 앞선 풀이를 남김없이 지운다', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-manual-rm-'))
      const resources = path.join(root, 'manual', '9.9.9', 'Astera.app', 'Contents', 'Resources')
      await fs.mkdir(resources, { recursive: true })
      // Electron 이 진짜 asar 로 알아보는 파일이어야 패치가 끼어든다.
      const defaultApp = path.join(path.dirname(path.dirname(electronBinary!)), 'Resources', 'default_app.asar')
      await fs.copyFile(defaultApp, path.join(resources, 'app.asar'))
      await fs.writeFile(path.join(resources, 'other.txt'), 'x')

      const target = path.join(root, 'manual', '9.9.9')
      const module = pathToFileURL(fileURLToPath(new URL('./manualInstall.ts', import.meta.url))).href
      const script =
        `const { nodeManualInstallIO } = await import(${JSON.stringify(module)});` +
        `await nodeManualInstallIO.rm(${JSON.stringify(target)});`
      try {
        await execFileAsync(electronBinary!, ['--no-warnings', '--input-type=module', '-e', script], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        })
        await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }
)

// 직접 설치 창이 Finder 로 보여 주는 것은 업데이트 캐시 안의 복사본이다. 응용 프로그램 폴더로 끌어다 놓는 대신
// 그 자리에서 더블클릭하면 새 버전이 캐시에서 돌고, 응용 프로그램 폴더에는 이전 버전이 남는다 — Dock 과 Spotlight 가
// 다음에 여는 것은 그 이전 버전이다(1.5.5 에서 실제로 일어남: /Applications 는 1.4.16 이었다).
describe('manualInstallCopyOf — 업데이트 캐시의 복사본에서 돌고 있는가', () => {
  const exe = (bundle: string): string => path.join(bundle, 'Contents', 'MacOS', 'Astera')

  it('astera-updater/manual/<version> 안의 앱이면 그 앱 번들을 돌려준다', () => {
    const bundle = path.join('/Users/me/Library/Caches', 'astera-updater', 'manual', '1.5.5', 'Astera.app')
    expect(manualInstallCopyOf(exe(bundle), 'astera-updater')).toBe(bundle)
  })

  it('응용 프로그램 폴더의 앱은 아니다', () => {
    expect(manualInstallCopyOf(exe('/Applications/Astera.app'), 'astera-updater')).toBeNull()
  })

  it('업데이터 캐시가 아닌 manual 폴더는 아니다', () => {
    expect(manualInstallCopyOf(exe(path.join('/Users/me/Downloads', 'manual', '1.5.5', 'Astera.app')), 'astera-updater')).toBeNull()
  })

  it('앱 번들 밖의 실행 파일(개발용 Electron 등)은 아니다', () => {
    expect(manualInstallCopyOf('/Users/me/astera-updater/manual/1.5.5/node_modules/.bin/electron', 'astera-updater')).toBeNull()
  })
})

function recordingCopyIO(existing: string[]): { calls: string[]; io: CopyInstallIO } {
  const calls: string[] = []
  return {
    calls,
    io: {
      exists: async (p) => existing.includes(p),
      trash: async (p) => void calls.push(`trash ${p}`),
      run: async (file, args) => void calls.push(`${file} ${args.join(' ')}`)
    }
  }
}

describe('installCopyToApplications — 복사본을 응용 프로그램 폴더에 설치한다', () => {
  const bundle = path.join('/c', 'astera-updater', 'manual', '1.5.5', 'Astera.app')
  const target = path.join('/Apps', 'Astera.app')

  it('있던 앱은 휴지통으로 보내고, 복사하고, quarantine 을 뗀다', async () => {
    const { calls, io } = recordingCopyIO([target])
    expect(await installCopyToApplications({ bundle, applicationsDir: '/Apps', io })).toBe(target)
    expect(calls).toEqual([`trash ${target}`, `ditto ${bundle} ${target}`, `xattr -dr com.apple.quarantine ${target}`])
  })

  it('있던 앱이 없으면 휴지통에 보낼 것도 없다', async () => {
    const { calls, io } = recordingCopyIO([])
    await installCopyToApplications({ bundle, applicationsDir: '/Apps', io })
    expect(calls[0]).toBe(`ditto ${bundle} ${target}`)
  })
})

// 진짜 ditto 로 한 번. 옮기지 않고 복사하는 것이 요점이다: 이 복사본에서 띄운 Host 가 아직 그 경로에서 돌고 있다.
describe.runIf(process.platform === 'darwin')('installCopyToApplications — 진짜 폴더를 상대로', () => {
  it('새 앱으로 바꾸고, 캐시의 복사본은 그대로 둔다', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-copy-install-'))
    try {
      const bundle = path.join(root, 'astera-updater', 'manual', '9.9.9', 'Astera.app')
      await fs.mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true })
      await fs.writeFile(path.join(bundle, 'Contents', 'MacOS', 'Astera'), 'new')
      const apps = path.join(root, 'Applications')
      await fs.mkdir(path.join(apps, 'Astera.app', 'Contents', 'MacOS'), { recursive: true })
      await fs.writeFile(path.join(apps, 'Astera.app', 'Contents', 'MacOS', 'Astera'), 'old')
      await fs.writeFile(path.join(apps, 'Astera.app', 'Contents', 'old-only'), 'x')
      const trashed: string[] = []
      const io: CopyInstallIO = {
        exists: (p) => fs.access(p).then(() => true, () => false),
        trash: async (p) => {
          trashed.push(p)
          await fs.rm(p, { recursive: true })
        },
        run: async (file, args) => void (await execFileAsync(file, args))
      }

      const installed = await installCopyToApplications({ bundle, applicationsDir: apps, io })

      expect(trashed).toEqual([path.join(apps, 'Astera.app')])
      expect(await fs.readFile(path.join(installed, 'Contents', 'MacOS', 'Astera'), 'utf8')).toBe('new')
      await expect(fs.stat(path.join(installed, 'Contents', 'old-only'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fs.readFile(path.join(bundle, 'Contents', 'MacOS', 'Astera'), 'utf8')).toBe('new')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
