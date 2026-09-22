import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostStatus, runHostCommand } from './host'
import { userDataDir } from '../core/orchestration/cliDiscovery'
import { hostAddress } from '../host/address'
import { startHostServer } from '../host/server'
import { HOST_PROTOCOL } from '../core/host/protocol'
import { exitCodeFor } from '../core/orchestration/cliOutput'

describe('hostStatus', () => {
  // Host 가 없을 때도 사람에게 할 말이 있어야 한다 — 어느 프로필을 봤는지와, 파일에 몇 개가 있는지.
  it('Host 가 없으면 running: false 와 프로필을 낸다', () => {
    expect(hostStatus({ conn: null, profileDir: 'D:/p', jobs: 3 })).toEqual({
      running: false,
      protocol: 3,
      features: [],
      profile: 'D:/p',
      jobs: 3
    })
  })

  it('Host 가 있으면 그 pid 와 버전을 싣는다', () => {
    const conn = {
      hello: { host: '1.3.25', pid: 42, startedAt: 'T', features: ['proc', 'orch'] }
    } as never
    expect(hostStatus({ conn, profileDir: 'D:/p', jobs: 3 })).toEqual({
      running: true,
      pid: 42,
      version: '1.3.25',
      protocol: 3,
      features: ['proc', 'orch'],
      profile: 'D:/p',
      jobs: 3
    })
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
        log: { write: () => {}, close: () => {} }
      })
      try {
        const up = await runHostCommand({ cmd: 'host-status', env, platform: process.platform, home })
        expect(up.code).toBe(0)
        expect(up.body).toMatchObject({
          running: true,
          pid: process.pid,
          version: '9.9.9',
          features: expect.arrayContaining(['proc']),
          profile: profileDir,
          jobs: 3
        })
      } finally {
        await server.close()
      }
      const down = await runHostCommand({ cmd: 'host-status', env, platform: process.platform, home })
      expect(down.code).toBe(exitCodeFor('HOST_NOT_RUNNING'))
      expect(down.body).toMatchObject({ running: false, profile: profileDir, jobs: 3 })
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
