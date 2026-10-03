import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  cliHostTarget,
  hostStatus,
  hostStopResult,
  hostStartTargets,
  otherProtocolHost,
  preparedRuntime,
  runHostCommand,
  startHostNotice
} from './host'
import { userDataDir } from '../core/orchestration/cliDiscovery'
import { pendingReportsDirIn } from '../core/orchestration/pendingReports'
import { hostAddress } from '../host/address'
import { startHostServer, type HostServerDeps } from '../host/server'
import { HOST_PROTOCOL } from '../core/host/protocol'
import { ensureHostKey, hostProof } from '../core/host/hostKey'
import { HOST_STOP_WAIT_MS, HOST_UNRESPONSIVE_MS, SPAWN_DEADLINE_MS } from '../core/host/unresponsive'
import { encodeLine } from '../host/framing'
import { exitCodeFor } from '../core/orchestration/cliOutput'
import { hostRuntimePaths } from '../core/host/runtime'
import { errEnvelope, type CliError } from '../core/orchestration/cliOutput'

/**
 * 리뷰 I1. host 명령의 실패는 다른 모든 명령과 같은 오류 봉투로 나간다 — `jq -e .ok` 가 false 이고
 * `error.code` 와 `nextSteps` 가 있다. run.ts 는 실패를 `fail()` 로만 내보내므로(run.test.ts 의
 * FAIL_SEAM 가드), 여기서 확인하는 것은 결과가 실패 모양인가와 그 봉투다.
 */
const failed = (r: Awaited<ReturnType<typeof runHostCommand>>, cmd: string): CliError => {
  if (r.ok) throw new Error(`${cmd} succeeded: ${JSON.stringify(r.body)}`)
  const env = JSON.parse(errEnvelope(r.error, cmd)) as { ok: boolean }
  expect(env.ok, `${cmd} printed ok: true on a failure`).toBe(false)
  expect(exitCodeFor(r.error.code)).toBeGreaterThan(0)
  return r.error
}
const envelopeOf = (
  r: Awaited<ReturnType<typeof runHostCommand>>,
  cmd: string
): { ok: boolean; error: { nextSteps: string[] } } => {
  if (r.ok) throw new Error(`${cmd} succeeded`)
  return JSON.parse(errEnvelope(r.error, cmd)) as { ok: boolean; error: { nextSteps: string[] } }
}

/** A fake Host's answer to the nonce in the first line it was sent (protocol 4, core/host/hostKey.ts). */
const proofOf = (key: string, firstData: string): string =>
  hostProof(key, (JSON.parse(firstData.split(/\r?\n/)[0]) as { nonce?: string }).nonce ?? '')

describe('hostStatus', () => {
  // Host 가 없을 때도 사람에게 할 말이 있어야 한다 — 어느 프로필을 봤는지와, 파일에 몇 개가 있는지.
  //
  // **이름이 `jobsInProfile` 인 이유**(ruling F57/e): host stop 이 거절하며 세는 것은 이것이 아니라
  // 지금 일이 도는 Run 의 수다. 둘 다 `jobs` 이던 동안에는 스크립트가 하나를 읽고 다른 하나로 행동할
  // 수 있었다.
  it('Host 가 없으면 running: false 와 프로필을 낸다', () => {
    expect(hostStatus({ conn: null, profileDir: 'D:/p', jobsInProfile: 3 })).toEqual({
      running: false,
      protocol: HOST_PROTOCOL,
      features: [],
      profile: 'D:/p',
      jobsInProfile: 3
    })
  })

  it('Host 가 있으면 그 pid 와 버전을 싣는다', () => {
    const conn = {
      hello: { host: '1.3.25', pid: 42, startedAt: 'T', features: ['proc', 'orch'] }
    } as never
    expect(hostStatus({ conn, profileDir: 'D:/p', jobsInProfile: 3 })).toEqual({
      running: true,
      pid: 42,
      version: '1.3.25',
      protocol: HOST_PROTOCOL,
      features: ['proc', 'orch'],
      profile: 'D:/p',
      jobsInProfile: 3
    })
  })

  // 남은 한계 Task 5: 옛 앱이 붙은 Host 는 그 사실을 hello 에 싣고, status 가 사람에게 그대로 말한다.
  it('옛 앱(1.3.25 이하)이 붙어 있으면 그렇다고 말한다', () => {
    const conn = {
      hello: { host: '1.3.26', pid: 42, startedAt: 'T', features: [], legacyApp: true }
    } as never
    expect(hostStatus({ conn, profileDir: 'D:/p', jobsInProfile: 0 })).toMatchObject({
      running: true,
      legacyApp: true,
      warning: 'Astera 1.3.25 or older is attached; update it'
    })
  })
})

// Host S2 fix round, ruling (b): a Host that is leaving may wait up to SPAWN_DEADLINE_MS for its
// spawns in flight before it closes, so `host stop` must outwait that and then still allow the usual
// silence before it calls the Host stuck.
describe('the wait host stop gives a retire', () => {
  it("outlasts the Host's own settle for spawns in flight, plus the silence rule", () => {
    expect(HOST_STOP_WAIT_MS).toBeGreaterThan(SPAWN_DEADLINE_MS)
    expect(HOST_STOP_WAIT_MS).toBe(SPAWN_DEADLINE_MS + HOST_UNRESPONSIVE_MS)
  })
})

describe('hostStopResult', () => {
  // 없는 것을 멈추는 것은 실패가 아니다 — 0으로 끝난다.
  it('Host 가 없으면 0 으로 끝나고 그렇다고 말한다', () => {
    expect(hostStopResult({ outcome: 'absent' })).toEqual({
      ok: true,
      body: { stopped: true, message: 'no Host was running' }
    })
  })

  it('물러났으면 0 으로 끝난다', () => {
    expect(hostStopResult({ outcome: 'stopped' })).toEqual({ ok: true, body: { stopped: true } })
  })

  // 명세 §12 의 문구를 그대로 옮긴다 — 그 문서가 회차 단위로 개정됐다(2026-09-22의 덧붙임).
  // 세는 것이 Run 이고 "Job" 이라고 적으면 회차 둘짜리 Job 하나가 둘로 읽히기 때문이다.
  // 종료 코드는 CONFLICT(6) — host stop 이 거절하는 유일한 경우다.
  it('거절되면 CONFLICT 로 끝나고 수를 문장에 담는다', () => {
    expect(hostStopResult({ outcome: 'refused', sessions: 2, runs: 1 })).toEqual({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'Cannot stop Host: 2 sessions and 1 run are still running.',
        details: { sessions: 2, runs: 1 }
      }
    })
  })

  it('하나씩이면 단수로 말한다', () => {
    expect(hostStopResult({ outcome: 'refused', sessions: 1, runs: 1 })).toMatchObject({
      error: { message: 'Cannot stop Host: 1 session and 1 run are still running.' }
    })
  })

  // Host 가 아예 없는 것(0)도 아니고 물러난 것(0)도 아니다 — 답이 없는 것은 셋째 결말이고, 사람이
  // 다음에 할 일이 다르므로 그렇다고 말한다. TIMEOUT(7)은 열 개짜리 표에 이미 있는 코드다.
  it('답이 없으면 TIMEOUT 으로 끝나고, 있었던 일을 그대로 말한다', () => {
    expect(hostStopResult({ outcome: 'timeout', waitedMs: 15_000 })).toEqual({
      ok: false,
      error: {
        code: 'TIMEOUT',
        message: 'retire was sent, but the Host did not answer within 15000ms — it may still be running (and possibly stuck)',
        details: { waitedMs: 15_000 }
      }
    })
  })
})

// 감사 #12. 판이 다른 CLI 는 제 판의 주소만 보므로 살아 있는 Host 를 "없다" 로 읽었다. 가짜
// 리스너를 다른 판의 주소에 세우고, 파일로 답하기 전의 확인이 그것을 찾는지 본다.
describe('otherProtocolHost — 같은 프로필을 다른 판의 Host 가 쥐고 있는가', () => {
  const listenAt = async (protocol: number, profileDir: string): Promise<{ address: string; close(): Promise<void> }> => {
    const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol })
    if (addr.dirToPrepare) await fs.mkdir(addr.dirToPrepare, { recursive: true, mode: 0o700 })
    const server = net.createServer((s) => s.end())
    await new Promise<void>((resolve) => server.listen(addr.address, resolve))
    return {
      address: addr.address,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        if (addr.dirToPrepare) await fs.rm(addr.dirToPrepare, { recursive: true, force: true })
      }
    }
  }

  it('다른 판의 주소에 누가 있으면 그 판과 주소를 낸다', async () => {
    const profileDir = path.join(os.tmpdir(), `astera-probe-${process.pid}-a`)
    const other = await listenAt(HOST_PROTOCOL + 1, profileDir)
    try {
      expect(await otherProtocolHost({ profileDir, platform: process.platform, tmpDir: os.tmpdir() })).toEqual({
        protocol: HOST_PROTOCOL + 1,
        address: other.address
      })
    } finally {
      await other.close()
    }
  })

  it('자기 판의 주소에 있는 것과 다른 프로필의 것은 세지 않는다', async () => {
    const profileDir = path.join(os.tmpdir(), `astera-probe-${process.pid}-b`)
    const same = await listenAt(HOST_PROTOCOL, profileDir)
    const elsewhere = await listenAt(HOST_PROTOCOL + 1, `${profileDir}-other`)
    try {
      expect(await otherProtocolHost({ profileDir, platform: process.platform, tmpDir: os.tmpdir() })).toBeNull()
    } finally {
      await same.close()
      await elsewhere.close()
    }
  })

  // 권하는 다음 명령이 `host start` 이므로, 그 명령이 다른 판의 Host 를 두고 같은 프로필에 두 번째
  // Host 를 띄우면 안 된다. 띄우기 전에 거절한다.
  it('host start 는 다른 판의 Host 가 있으면 띄우지 않고 9 로 거절한다', async () => {
    const profileDir = path.join(os.tmpdir(), `astera-probe-${process.pid}-d`)
    const other = await listenAt(HOST_PROTOCOL + 1, profileDir)
    try {
      const r = await runHostCommand({
        cmd: 'host-start',
        env: { ASTERA_PROFILE_DIR: profileDir },
        platform: process.platform,
        home: os.tmpdir()
      })
      expect(failed(r, 'host-start')).toMatchObject({
        code: 'VERSION_MISMATCH',
        details: { hostProtocol: HOST_PROTOCOL + 1, hostAddress: other.address }
      })
      // 실패한 명령이 `host start` 자신이므로 그것을 다시 권하지 않는다
      expect(envelopeOf(r, 'host-start').error.nextSteps).toEqual(['astera version'])
    } finally {
      await other.close()
    }
  })

  // 리뷰 M5. `status` 가 9 로 답하는 자리에서 `host status` 가 3 이면 스크립트는 두 이야기를 듣는다.
  it('host status 도 다른 판의 Host 가 있으면 9 다', async () => {
    const profileDir = path.join(os.tmpdir(), `astera-probe-${process.pid}-e`)
    const other = await listenAt(HOST_PROTOCOL + 1, profileDir)
    try {
      const r = await runHostCommand({
        cmd: 'host-status',
        env: { ASTERA_PROFILE_DIR: profileDir },
        platform: process.platform,
        home: os.tmpdir()
      })
      expect(failed(r, 'host-status')).toMatchObject({
        code: 'VERSION_MISMATCH',
        details: { hostProtocol: HOST_PROTOCOL + 1, hostAddress: other.address }
      })
    } finally {
      await other.close()
    }
  })

  it('아무도 없으면 null 이다', async () => {
    const profileDir = path.join(os.tmpdir(), `astera-probe-${process.pid}-c`)
    expect(await otherProtocolHost({ profileDir, platform: process.platform, tmpDir: os.tmpdir() })).toBeNull()
  })
})

describe('runHostCommand — host stop against a real Host', () => {
  // 없으면 0 — 빈 profile 에는 Host 가 없다.
  it('Host 가 없으면 0 으로 끝난다', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-home-'))
    try {
      const down = await runHostCommand({ cmd: 'host-stop', env: {}, platform: process.platform, home })
      expect(down).toMatchObject({ ok: true, body: { stopped: true } })
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  // 일하는 것이 있으면 거절되고(CONFLICT), 그것이 사라지면 이번에는 실제로 물러나고 주소가 빈다.
  it('일하는 것이 있으면 거절하고, 없으면 물러나 주소를 비운다', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-home-'))
    try {
      const env = {} as NodeJS.ProcessEnv
      const profileDir = userDataDir({ platform: process.platform, env, home })
      await fs.mkdir(profileDir, { recursive: true })
      const addr = hostAddress({
        profileDir,
        platform: process.platform,
        tmpDir: os.tmpdir(),
        protocol: HOST_PROTOCOL
      })
      let sessions = 2
      const liveCounts: HostServerDeps['liveCounts'] = () => ({ sessions, runs: 0 })
      const server = await startHostServer({
        address: addr.address,
        dirToPrepare: addr.dirToPrepare,
        version: '9.9.9',
        idleMs: 60_000,
        onIdle: () => void server.close(),
        liveCounts,
        hostKey: await ensureHostKey(profileDir),
        log: { write: () => {}, close: () => {} }
      })
      try {
        const refused = await runHostCommand({ cmd: 'host-stop', env, platform: process.platform, home })
        expect(failed(refused, 'host-stop')).toMatchObject({ code: 'CONFLICT', details: { sessions: 2, runs: 0 } })
        expect(exitCodeFor('CONFLICT')).toBe(6)

        sessions = 0
        const stopped = await runHostCommand({ cmd: 'host-stop', env, platform: process.platform, home })
        expect(stopped).toEqual({ ok: true, body: { stopped: true } })

        // The address is free: a fresh connect finds nobody, the way it would after any Host leaves.
        const after = await runHostCommand({ cmd: 'host-status', env, platform: process.platform, home })
        expect(failed(after, 'host-status')).toMatchObject({ code: 'HOST_NOT_RUNNING', details: { running: false } })
      } finally {
        await server.close().catch(() => {})
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

describe('runHostCommand — host stop against a Host whose event loop is wedged', () => {
  // 진짜 Host 는 손대지 않는다: handshake 만 답하고 그 뒤로는 아무 말도 하지 않는 raw 소켓 서버로,
  // docs/2026-09-22-host-unresponsive-recovery-design.md 가 적어 둔 동기 호출에 묶여 이벤트 루프가
  // 멎은 Host 를 흉내 낸다 — retire 에도, 그 무엇에도 답이 없다.
  it('답이 없으면 매달리지 않고 TIMEOUT 으로 끝난다', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-home-'))
    let key = ''
    const server = net.createServer((sock) => {
      sock.setEncoding('utf8')
      let helloed = false
      sock.on('data', (d: string) => {
        if (helloed) return // wedged: hears `retire` land, never answers it
        helloed = true
        sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, host: '9.9.9', pid: 1, startedAt: 'T', features: [], proof: proofOf(key, d) }))
      })
    })
    try {
      const env = {} as NodeJS.ProcessEnv
      const profileDir = userDataDir({ platform: process.platform, env, home })
      await fs.mkdir(profileDir, { recursive: true })
      key = await ensureHostKey(profileDir)
      const addr = hostAddress({
        profileDir,
        platform: process.platform,
        tmpDir: os.tmpdir(),
        protocol: HOST_PROTOCOL
      })
      if (addr.dirToPrepare) await fs.mkdir(addr.dirToPrepare, { recursive: true, mode: 0o700 })
      await new Promise<void>((resolve) => server.listen(addr.address, resolve))

      const result = await runHostCommand({
        cmd: 'host-stop',
        env,
        platform: process.platform,
        home,
        stopTimeoutMs: 50
      })
      expect(failed(result, 'host-stop')).toMatchObject({ code: 'TIMEOUT' })
    } finally {
      server.close()
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

describe('runHostCommand — host status against a real Host', () => {
  // No `$SP/prof-dev` dev profile and no display for Electron are available in this environment, so
  // there is no live app to point the real CLI at (task-2-brief.md Step 11). This drives a real
  // `startHostServer` instance instead — the same server the Host process runs — end to end, which is
  // the closest available substitute for that manual check.
  it('Host 가 있으면 running:true 를, 죽으면 running:false 를 낸다', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-home-'))
    try {
      const env = {} as NodeJS.ProcessEnv
      const profileDir = userDataDir({ platform: process.platform, env, home })
      await fs.mkdir(profileDir, { recursive: true })
      await fs.writeFile(
        path.join(profileDir, 'orchestration.json'),
        JSON.stringify({ jobs: [{}, {}, {}] })
      )
      const addr = hostAddress({
        profileDir,
        platform: process.platform,
        tmpDir: os.tmpdir(),
        protocol: HOST_PROTOCOL
      })
      const server = await startHostServer({
        address: addr.address,
        dirToPrepare: addr.dirToPrepare,
        version: '9.9.9',
        idleMs: 60_000,
        onIdle: () => {},
        hostKey: await ensureHostKey(profileDir),
        log: { write: () => {}, close: () => {} }
      })
      try {
        const up = await runHostCommand({ cmd: 'host-status', env, platform: process.platform, home })
        expect(up.ok).toBe(true)
        expect((up as { body: unknown }).body).toMatchObject({
          running: true,
          pid: process.pid,
          version: '9.9.9',
          features: expect.arrayContaining(['proc']),
          profile: profileDir,
          jobsInProfile: 3
        })
      } finally {
        await server.close()
      }
      const down = await runHostCommand({ cmd: 'host-status', env, platform: process.platform, home })
      // 없다는 것도 오류 봉투다 — 무엇을 봤는지는 details 가 싣는다
      expect(failed(down, 'host-status')).toMatchObject({
        code: 'HOST_NOT_RUNNING',
        details: { running: false, profile: profileDir, jobsInProfile: 3 }
      })
      expect(envelopeOf(down, 'host-status').error.nextSteps).toEqual(['astera host start'])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

describe('cliHostTarget', () => {
  const home = path.join('C:', 'Users', 'x')

  it('환경변수가 없으면 프로필에서 계산한 주소다', () => {
    const env = { APPDATA: path.join('C:', 'a') } as NodeJS.ProcessEnv
    const target = cliHostTarget({ env, platform: process.platform, home })
    expect(target.profileDir).toBe(userDataDir({ platform: process.platform, env, home }))
    expect(target.address).toBe(
      hostAddress({
        profileDir: target.profileDir,
        platform: process.platform,
        tmpDir: os.tmpdir(),
        protocol: HOST_PROTOCOL
      }).address
    )
  })

  // 앱이 띄운 세션은 자기를 띄운 Host 와 말해야 한다 — 설치본이 함께 떠 있어도 그쪽으로 새면 안 된다.
  it('ASTERA_HOST 는 계산한 주소를 이긴다', () => {
    const env = { APPDATA: path.join('C:', 'a'), ASTERA_HOST: '\\\\.\\pipe\\given' } as NodeJS.ProcessEnv
    expect(cliHostTarget({ env, platform: process.platform, home }).address).toBe('\\\\.\\pipe\\given')
  })

  // 주소는 그 Host 가 어느 프로필을 쓰는지 말해 주지 않는다. 상태 파일과 보고 큐가 있는 곳은
  // 여전히 프로필이 정한다.
  it('주소를 지정해도 프로필은 프로필에서 온다', () => {
    const env = { APPDATA: path.join('C:', 'a'), ASTERA_HOST: 'given' } as NodeJS.ProcessEnv
    expect(cliHostTarget({ env, platform: process.platform, home }).profileDir).toBe(
      userDataDir({ platform: process.platform, env, home })
    )
  })

  // 세션 밖에서 개발본을 가리키는 유일한 손잡이다. `infoPathFor` 가 이 매핑을 쥐고 있었고 그
  // 함수는 없어졌으므로(Task 9), 이 자리가 그것을 이어받는다.
  it('ASTERA_PROFILE=dev 면 개발본의 프로필이다', () => {
    const env = { APPDATA: path.join('C:', 'a'), ASTERA_PROFILE: 'dev' } as NodeJS.ProcessEnv
    expect(cliHostTarget({ env, platform: 'win32', home }).profileDir).toBe(
      userDataDir({ platform: 'win32', env, home, dev: true })
    )
  })

  // 빈 값은 "지정하지 않았다"와 같다 — 셔틀이 빈 문자열을 넣는 날 CLI 가 빈 주소로 접속하면 안 된다.
  it('빈 ASTERA_HOST 는 없는 것과 같다', () => {
    const env = { APPDATA: path.join('C:', 'a'), ASTERA_HOST: '' } as NodeJS.ProcessEnv
    const computed = cliHostTarget({ env: { APPDATA: path.join('C:', 'a') }, platform: process.platform, home })
    expect(cliHostTarget({ env, platform: process.platform, home }).address).toBe(computed.address)
  })

  // **F43.** 개발본의 `-dev` 접미사는 `app.isPackaged` 에서 오고(src/main/index.ts) 그것을 내보내는
  // 환경변수가 없었다 — 그래서 개발본이 띄운 워커가 설치본의 프로필을 계산해 설치본의 Host 에
  // 말을 걸었다. 이제 앱이 자기 폴더를 실어 보내고(ASTERA_PROFILE_DIR), 주소는 그 폴더에서 나온다.
  describe('ASTERA_PROFILE_DIR', () => {
    const installed = userDataDir({ platform: 'win32', env: { APPDATA: path.join('C:', 'a') }, home })
    const dev = userDataDir({ platform: 'win32', env: { APPDATA: path.join('C:', 'a') }, home, dev: true })

    it('앱이 실어 보낸 프로필이 계산을 이긴다', () => {
      const env = { APPDATA: path.join('C:', 'a'), ASTERA_PROFILE_DIR: dev } as NodeJS.ProcessEnv
      expect(cliHostTarget({ env, platform: 'win32', home }).profileDir).toBe(dev)
    })

    // 주소도 그 폴더에서 나온다 — 설치본의 것과 같은 주소가 나오면 개발본 워커가 설치본 Host 에
    // 그대로 닿는다.
    it('주소가 그 프로필의 것이고 설치본의 것이 아니다', () => {
      const env = { APPDATA: path.join('C:', 'a'), ASTERA_PROFILE_DIR: dev } as NodeJS.ProcessEnv
      const addrFor = (profileDir: string): string =>
        hostAddress({ profileDir, platform: 'win32', tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL }).address
      expect(cliHostTarget({ env, platform: 'win32', home }).address).toBe(addrFor(dev))
      expect(cliHostTarget({ env, platform: 'win32', home }).address).not.toBe(addrFor(installed))
    })

    // 못 보낸 보고가 적히는 곳도 이 폴더다(run.ts 의 writePendingReport). 개발본의 보고가 설치본
    // 큐에 떨어지면 설치본 앱과 Host 가 그것을 빨아들인다 — 이것이 이 결함을 치명으로 만든 쪽이다.
    it('보고 큐가 그 프로필 안이고 설치본 안이 아니다', () => {
      const env = { APPDATA: path.join('C:', 'a'), ASTERA_PROFILE_DIR: dev } as NodeJS.ProcessEnv
      const queue = pendingReportsDirIn(cliHostTarget({ env, platform: 'win32', home }).profileDir)
      expect(queue.startsWith(dev)).toBe(true)
      expect(queue.startsWith(pendingReportsDirIn(installed))).toBe(false)
    })

    // `ASTERA_HOST` 는 주소만 이긴다 — 상태 파일과 보고 큐는 여전히 프로필의 것이다.
    it('ASTERA_HOST 가 있어도 프로필은 실어 보낸 것이다', () => {
      const env = { APPDATA: path.join('C:', 'a'), ASTERA_PROFILE_DIR: dev, ASTERA_HOST: 'given' } as NodeJS.ProcessEnv
      const t = cliHostTarget({ env, platform: 'win32', home })
      expect(t.address).toBe('given')
      expect(t.profileDir).toBe(dev)
    })

    it('빈 값은 없는 것과 같다', () => {
      const env = { APPDATA: path.join('C:', 'a'), ASTERA_PROFILE_DIR: '' } as NodeJS.ProcessEnv
      expect(cliHostTarget({ env, platform: 'win32', home }).profileDir).toBe(installed)
    })

    // **F47·F51.** 주소는 이 경로 문자열의 sha256 이다. 같은 폴더를 다른 철자로 적으면 살아 있는
    // Host 를 두고 `running: false` 라고 답하게 되는데, 그것이 이 설계가 가장 애써 피하는
    // 거짓말이다. 실려 오는 값은 전부 이미 네이티브 철자이고 끝 구분자도 없으므로, 이 맞춤은
    // 기존 주소를 하나도 바꾸지 않는다.
    const of = (v: string, platform: NodeJS.Platform = 'win32'): { address: string; profileDir: string } =>
      cliHostTarget({
        env: { APPDATA: path.join('C:', 'a'), ASTERA_PROFILE_DIR: v } as NodeJS.ProcessEnv,
        platform,
        home
      })

    it.each([
      ['정슬래시로 적은 것', dev.replace(/\\/g, '/')],
      ['끝에 구분자를 붙인 것', `${dev}\\`],
      ['둘 다', `${dev.replace(/\\/g, '/')}/`]
    ])('%s 이 네이티브 철자와 한 Host·한 프로필·한 큐로 모인다', (_label, spelled) => {
      // 이 테스트가 무엇을 재는지 — 두 철자가 실제로 다르다. 같아지면 단정이 공짜가 된다.
      expect(spelled).not.toBe(dev)
      expect(of(spelled).address).toBe(of(dev).address)
      expect(of(spelled).profileDir).toBe(dev)
      // 보고 큐도 같은 값에서 나온다 — 철자가 갈리면 큐도 둘로 갈린다.
      expect(pendingReportsDirIn(of(spelled).profileDir)).toBe(pendingReportsDirIn(dev))
    })

    // posix 에서는 슬래시 방향을 건드리지 않는다. 역슬래시는 그쪽에서 파일 이름에 쓸 수 있는
    // 글자다. 끝 구분자는 거기서도 같은 문제라 걷는다.
    it('posix 에서는 방향은 두고 끝 구분자만 걷는다', () => {
      const given = '/home/me/.config/astera-dev'
      expect(of(given, 'linux').profileDir).toBe(given)
      expect(of(`${given}/`, 'linux').profileDir).toBe(given)
      expect(of('/home/me/back\\slash', 'linux').profileDir).toBe('/home/me/back\\slash')
    })

    // **뿌리는 걷지 않는다.** `C:\` 를 `C:` 로 만들면 win32 에서 그 드라이브의 현재 디렉터리를
    // 뜻하고, posix 의 `/` 를 걷으면 빈 문자열이 된다. 프로필이 뿌리일 리는 없지만, 그냥 두는
    // 것과 망가뜨리는 것은 다른 일이다.
    it('뿌리 하나짜리 경로를 망가뜨리지 않는다', () => {
      expect(of('C:\\').profileDir).toBe('C:\\')
      expect(of('C:/').profileDir).toBe('C:\\')
      expect(of('/', 'linux').profileDir).toBe('/')
      expect(of('//', 'linux').profileDir).toBe('/')
      // **구분자가 없는 드라이브.** 걷을 것이 없으므로 그대로여야 하는데, 되돌리는 쪽이 원본의
      // 마지막 글자를 붙이는 바람에 `C::` 가 됐다 — 어떤 생산자도 이 값을 내지 않지만, 위 세 줄이
      // 지키려는 성질("그냥 두는 것과 망가뜨리는 것은 다르다")을 정확히 어긴다.
      expect(of('C:').profileDir).toBe('C:')
    })

    // posix 에서 역슬래시는 파일 이름에 쓸 수 있는 보통 글자이고, 그것이 끝에 오는 것도 마찬가지다.
    // 위 '방향은 두고' 테스트는 가운데에 있는 것만 붙잡고 있었다.
    it('posix 에서 끝의 역슬래시는 구분자가 아니다', () => {
      const withBackslash = `/home/me/dir${String.fromCharCode(92)}`
      expect(of(withBackslash, 'linux').profileDir).toBe(withBackslash)
    })
  })
})

describe('hostStartTargets', () => {
  // CLI 는 out/main/cli.js 로 돌고 host.js 는 그 옆에 있다. 패키지된 앱의 준비된 런타임이 있으면
  // 그쪽이 먼저다 — 앱이 쓰는 것과 같은 것을 띄워야 한 Host 를 둘이 나눠 쓴다.
  it('준비된 런타임이 있으면 그쪽을 먼저 본다', () => {
    const t = hostStartTargets({
      cliEntry: 'C:/app/out/main/cli.js',
      execPath: 'C:/app/electron.exe',
      profileDir: 'C:/profile',
      version: '1.3.25',
      runtime: {
        entryPath: 'C:/local/astera/host-runtime/node-24/builds/1.3.25/host.js',
        exePath: 'C:/local/astera/host-runtime/node-24/astera-host.exe'
      }
    })
    expect(t.candidates[0]).toBe('C:/local/astera/host-runtime/node-24/builds/1.3.25/host.js')
    expect(t.candidates[1]).toBe('C:/app/out/main/host.js')
    expect(t.logPath).toBe('C:/profile/host/host.log')
  })

  // The runtime exists so a Host that outlives the app does not run from Astera.exe and lock the
  // install folder against the next update (scripts/host-runtime.mjs). The app spawns the runtime's
  // host.js with astera-host.exe; a CLI that spawned it with its own Astera.exe kept that lock.
  it("runs the runtime's host.js with the runtime's own executable, and the one beside cli.js with its own", () => {
    const runtime = {
      entryPath: 'C:/local/astera/host-runtime/node-24/builds/1.3.25/host.js',
      exePath: 'C:/local/astera/host-runtime/node-24/astera-host.exe'
    }
    const t = hostStartTargets({
      cliEntry: 'C:/app/out/main/cli.js',
      execPath: 'C:/app/Astera.exe',
      profileDir: 'C:/profile',
      version: '1.3.25',
      runtime
    })
    expect(t.execPathFor(runtime.entryPath)).toBe(runtime.exePath)
    expect(t.execPathFor('C:/app/out/main/host.js')).toBe('C:/app/Astera.exe')
  })

  it('런타임이 없으면 CLI 옆의 host.js 하나다', () => {
    const t = hostStartTargets({
      cliEntry: 'D:/repo/out/main/cli.js',
      execPath: 'D:/repo/node_modules/electron/dist/electron.exe',
      profileDir: 'D:/profile',
      version: '1.3.25'
    })
    expect(t.candidates).toEqual(['D:/repo/out/main/host.js'])
  })

  it("passes its own executable, its own entry and the skills folder as the Host's CLI paths", () => {
    const t = hostStartTargets({ cliEntry: 'C:/app/out/main/cli.js', execPath: 'C:/app/Astera.exe', profileDir: 'C:/p', version: '1', skillsDir: 'C:/app/resources/skills' })
    expect(t.cli).toEqual({ exec: 'C:/app/Astera.exe', entry: 'C:/app/out/main/cli.js', skills: 'C:/app/resources/skills' })
  })
  it('passes no CLI paths when the skills folder cannot be found', () => {
    expect(hostStartTargets({ cliEntry: 'C:/app/out/main/cli.js', execPath: 'x', profileDir: 'C:/p', version: '1' }).cli).toBeUndefined()
  })
})

describe('preparedRuntime', () => {
  // `resourcesPath`/`readFile` are parameters precisely so this — the branch every packaged install
  // actually takes — does not need a real packaged build to test.
  it('준비된 runtime.json 을 읽어 그 build 의 entryPath 와 Host 실행 파일을 낸다', () => {
    const runtime = preparedRuntime({
      profileDir: 'C:\\Users\\x\\AppData\\Roaming\\astera',
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      resourcesPath: 'C:\\app\\resources',
      readFile: (p) => {
        expect(p).toBe('C:\\app\\resources\\host-runtime\\runtime.json')
        return JSON.stringify({ node: '24.15.0' })
      }
    })
    // CLI_VERSION falls back to '0.0.0' under vitest — __ASTERA_VERSION__ is a vite `define`, not set
    // for the test runner (host.ts's own comment on CLI_VERSION says the same).
    const paths = hostRuntimePaths({
      base: 'C:\\Users\\x\\AppData\\Local\\astera\\host-runtime',
      nodeVersion: '24.15.0',
      appVersion: '0.0.0'
    })
    expect(runtime).toEqual({ entryPath: paths.entryPath, exePath: paths.exePath })
  })

  it('runtime.json 이 없으면(개발) undefined 다 — host start 를 실패시키지 않는다', () => {
    const entry = preparedRuntime({
      profileDir: 'C:\\Users\\x\\AppData\\Roaming\\astera',
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      resourcesPath: 'C:\\app\\resources',
      readFile: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
    })
    expect(entry).toBeUndefined()
  })

  it('resourcesPath 가 없으면(진짜 Electron 프로세스가 아니면) 읽어 보지도 않고 undefined 다', () => {
    let readAttempted = false
    const entry = preparedRuntime({
      profileDir: 'C:\\Users\\x\\AppData\\Roaming\\astera',
      platform: 'win32',
      env: {},
      resourcesPath: undefined,
      readFile: () => {
        readAttempted = true
        return '{}'
      }
    })
    expect(entry).toBeUndefined()
    expect(readAttempted).toBe(false)
  })

  it('win32 가 아니면 읽어 보지도 않고 undefined 다', () => {
    let readAttempted = false
    const entry = preparedRuntime({
      profileDir: '/home/x/.config/astera',
      platform: 'linux',
      env: {},
      resourcesPath: '/app/resources',
      readFile: () => {
        readAttempted = true
        return JSON.stringify({ node: '24.15.0' })
      }
    })
    expect(entry).toBeUndefined()
    expect(readAttempted).toBe(false)
  })
})

// Stage 4 T6: a first `host start` can take seconds (runtime checks, the journal opening) and `host stop`
// waits for the Host to leave, and until now both printed nothing meanwhile. The notice goes to stderr
// only, after a second and then every five, and `--no-keepalive` turns it off like every other one.
describe('startHostNotice (stage 4 T6)', () => {
  it('says nothing for the first second, then speaks every five seconds until stopped', () => {
    vi.useFakeTimers()
    try {
      const lines: string[] = []
      const n = startHostNotice({ cmd: 'host-start', enabled: true, write: (l) => lines.push(l) })
      vi.advanceTimersByTime(999)
      expect(lines).toEqual([])
      vi.advanceTimersByTime(1)
      expect(lines).toEqual(['Starting the Astera Host... (1s so far)'])
      vi.advanceTimersByTime(5_000)
      expect(lines).toEqual(['Starting the Astera Host... (1s so far)', 'Starting the Astera Host... (6s so far)'])
      vi.advanceTimersByTime(5_000)
      expect(lines.at(-1)).toBe('Starting the Astera Host... (11s so far)')
      n.stop()
      vi.advanceTimersByTime(60_000)
      expect(lines).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says it is waiting for the Host to leave on host stop', () => {
    vi.useFakeTimers()
    try {
      const lines: string[] = []
      const n = startHostNotice({ cmd: 'host-stop', enabled: true, write: (l) => lines.push(l) })
      vi.advanceTimersByTime(6_000)
      n.stop()
      expect(lines).toEqual(['Waiting for the Host to leave... (1s so far)', 'Waiting for the Host to leave... (6s so far)'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing at all under --no-keepalive, and nothing for host status', () => {
    vi.useFakeTimers()
    try {
      const lines: string[] = []
      const off = startHostNotice({ cmd: 'host-start', enabled: false, write: (l) => lines.push(l) })
      const status = startHostNotice({ cmd: 'host-status', enabled: true, write: (l) => lines.push(l) })
      vi.advanceTimersByTime(60_000)
      off.stop()
      status.stop()
      expect(lines).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('an answer inside the first second prints nothing', () => {
    vi.useFakeTimers()
    try {
      const lines: string[] = []
      const n = startHostNotice({ cmd: 'host-stop', enabled: true, write: (l) => lines.push(l) })
      vi.advanceTimersByTime(500)
      n.stop()
      vi.advanceTimersByTime(60_000)
      expect(lines).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runHostCommand says it is waiting (stage 4 T6)', () => {
  /** A Host at this profile's own address that takes `helloAfterMs` to say hello, and after that
   *  answers nothing: slow to start, and never leaving on `retire`. */
  const slowHost = async (helloAfterMs: number): Promise<{ home: string; env: NodeJS.ProcessEnv; close(): Promise<void> }> => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-home-'))
    const env = {} as NodeJS.ProcessEnv
    const profileDir = userDataDir({ platform: process.platform, env, home })
    await fs.mkdir(profileDir, { recursive: true })
    const key = await ensureHostKey(profileDir)
    const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
    if (addr.dirToPrepare) await fs.mkdir(addr.dirToPrepare, { recursive: true, mode: 0o700 })
    const socks = new Set<net.Socket>()
    const server = net.createServer((sock) => {
      socks.add(sock)
      sock.on('error', () => {})
      sock.on('close', () => socks.delete(sock))
      let helloed = false
      sock.on('data', (d: Buffer | string) => {
        if (helloed) return
        helloed = true
        setTimeout(() => {
          if (!sock.destroyed)
            sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, host: '9.9.9', pid: 1, startedAt: 'T', features: [], proof: proofOf(key, String(d)) }))
        }, helloAfterMs)
      })
    })
    await new Promise<void>((resolve) => server.listen(addr.address, resolve))
    return {
      home,
      env,
      close: async () => {
        for (const s of socks) s.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await fs.rm(home, { recursive: true, force: true })
      }
    }
  }

  it('host start says the Host is starting while it waits for its answer, on stderr only', async () => {
    const host = await slowHost(300)
    try {
      const lines: string[] = []
      const r = await runHostCommand({
        cmd: 'host-start',
        env: host.env,
        platform: process.platform,
        home: host.home,
        notice: { firstMs: 20, everyMs: 1_000, write: (l) => lines.push(l) }
      })
      expect(r).toMatchObject({ ok: true, body: { running: true } })
      expect(lines.length).toBeGreaterThan(0)
      expect(lines[0]).toMatch(/^Starting the Astera Host\.\.\. \(\d+s so far\)$/)
    } finally {
      await host.close()
    }
  })

  it('host stop says it is waiting for the Host to leave, and the ending is unchanged', async () => {
    const host = await slowHost(0)
    try {
      const lines: string[] = []
      const r = await runHostCommand({
        cmd: 'host-stop',
        env: host.env,
        platform: process.platform,
        home: host.home,
        stopTimeoutMs: 300,
        notice: { firstMs: 20, everyMs: 50, write: (l) => lines.push(l) }
      })
      expect(failed(r, 'host-stop')).toMatchObject({ code: 'TIMEOUT' })
      expect(lines.length).toBeGreaterThan(1)
      expect(lines.every((l) => l.startsWith('Waiting for the Host to leave... ('))).toBe(true)
    } finally {
      await host.close()
    }
  })

  it('--no-keepalive keeps both silent', async () => {
    const host = await slowHost(300)
    try {
      const lines: string[] = []
      const notice = { firstMs: 20, everyMs: 50, write: (l: string) => lines.push(l) }
      const started = await runHostCommand({ cmd: 'host-start', env: host.env, platform: process.platform, home: host.home, noKeepalive: true, notice })
      expect(started).toMatchObject({ ok: true })
      const stopped = await runHostCommand({
        cmd: 'host-stop',
        env: host.env,
        platform: process.platform,
        home: host.home,
        stopTimeoutMs: 300,
        noKeepalive: true,
        notice
      })
      expect(failed(stopped, 'host-stop')).toMatchObject({ code: 'TIMEOUT' })
      expect(lines).toEqual([])
    } finally {
      await host.close()
    }
  })
})

// After the update that moved the protocol, a Host of the old one can still be serving the profile: it
// outlives the app by design, and a CLI of the new protocol cannot talk to it. `host start` says so
// (9) and names `--replace`; with it, the person chooses to have that Host leave, taking its sessions.
describe('runHostCommand — host start --replace', () => {
  /** A Host of `protocol` at this profile's address for it: it leaves when told to retire. */
  const otherHost = async (
    protocol: number
  ): Promise<{ home: string; env: NodeJS.ProcessEnv; got: string[]; close(): Promise<void> }> => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-home-'))
    const env = {} as NodeJS.ProcessEnv
    const profileDir = userDataDir({ platform: process.platform, env, home })
    await fs.mkdir(profileDir, { recursive: true })
    const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol })
    if (addr.dirToPrepare) await fs.mkdir(addr.dirToPrepare, { recursive: true, mode: 0o700 })
    const got: string[] = []
    const socks = new Set<net.Socket>()
    const server = net.createServer((sock) => {
      socks.add(sock)
      sock.setEncoding('utf8')
      sock.on('error', () => {})
      sock.on('close', () => socks.delete(sock))
      sock.on('data', (d: string) => {
        got.push(d)
        if (d.includes('"retire"')) {
          for (const s of socks) s.destroy()
          server.close()
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(addr.address, resolve))
    return {
      home,
      env,
      got,
      close: async () => {
        for (const s of socks) s.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await fs.rm(home, { recursive: true, force: true })
      }
    }
  }

  it('without --replace refuses with 9, names --replace, and sends that Host nothing', async () => {
    const old = await otherHost(HOST_PROTOCOL - 1)
    try {
      const r = await runHostCommand({ cmd: 'host-start', env: old.env, platform: process.platform, home: old.home, noKeepalive: true })
      const e = failed(r, 'host-start')
      expect(e.code).toBe('VERSION_MISMATCH')
      expect(e.message).toContain('astera host start --replace')
      expect(old.got.join('')).not.toContain('retire')
    } finally {
      await old.close()
    }
  })

  it('with --replace asks the older Host to leave, then goes on to start one', async () => {
    const old = await otherHost(HOST_PROTOCOL - 1)
    try {
      const r = await runHostCommand({ cmd: 'host-start', env: old.env, platform: process.platform, home: old.home, noKeepalive: true, replace: true })
      expect(old.got.join('')).toContain('"retire"')
      // Past the other Host: what is left is this test's lack of a Host build to start, not a 9.
      expect(failed(r, 'host-start').code).toBe('HOST_NOT_RUNNING')
      expect(failed(r, 'host-start').message).toContain('no Host build found')
    } finally {
      await old.close().catch(() => {})
    }
  })

  it('never replaces a Host of a newer protocol', async () => {
    const newer = await otherHost(HOST_PROTOCOL + 1)
    try {
      const r = await runHostCommand({ cmd: 'host-start', env: newer.env, platform: process.platform, home: newer.home, noKeepalive: true, replace: true })
      expect(failed(r, 'host-start').code).toBe('VERSION_MISMATCH')
      expect(newer.got.join('')).not.toContain('retire')
    } finally {
      await newer.close()
    }
  })
})
