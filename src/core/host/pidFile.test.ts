import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { tempDir } from '../worktrees/testRepo'
import {
  appPidFilePath,
  clearAppRunning,
  hostPidFilePath,
  liveAppPid,
  markAppRunning,
  parseHostPidFile,
  serializeHostPidFile
} from './pidFile'

describe('hostPidFilePath', () => {
  it('sits beside the Host log, in the profile', () => {
    expect(hostPidFilePath('C:/Users/x/AppData/Roaming/astera')).toBe(
      path.join('C:/Users/x/AppData/Roaming/astera', 'host', 'host.pid')
    )
  })
})

describe('parseHostPidFile', () => {
  const whole = { pid: 78672, startedAt: '2026-09-21T01:34:01.303Z', exe: 'C:\\x\\node.exe' }

  it('reads back what serialize wrote', () => {
    expect(parseHostPidFile(serializeHostPidFile(whole))).toEqual(whole)
  })

  // **Everything about this file is untrustworthy by the time it is read.** It is written by a
  // process that may have died between one field and the next, and it is read to decide which pid to
  // end — so a half-written or hand-edited file must read as "no answer", never as a pid.
  it('refuses anything that is not a whole record', () => {
    for (const text of [
      '',
      '   ',
      'not json',
      '{"pid":78672',
      '{}',
      '{"pid":"78672","startedAt":"x","exe":"y"}',
      '{"pid":0,"startedAt":"x","exe":"y"}',
      '{"pid":-1,"startedAt":"x","exe":"y"}',
      '{"pid":1.5,"startedAt":"x","exe":"y"}',
      '{"pid":78672,"exe":"y"}',
      '{"pid":78672,"startedAt":"x"}',
      '{"pid":78672,"startedAt":"","exe":"y"}',
      '{"pid":78672,"startedAt":"x","exe":""}',
      '[78672]',
      'null'
    ]) {
      expect(parseHostPidFile(text), text).toBeNull()
    }
  })

  it('ignores fields it does not know', () => {
    expect(parseHostPidFile('{"pid":7,"startedAt":"t","exe":"e","future":1}')).toEqual({
      pid: 7,
      startedAt: 't',
      exe: 'e'
    })
  })
})

// Host S3 Task 6 fix round 2 (review I1): the app says it is running, so a Host it is not attached
// to can tell "no app" from "an app that runs sessions of its own".
describe('the app pid file', () => {
  const dead = (): Promise<number> =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      c.on('exit', () => resolve(c.pid!))
    })
  it('sits in the profile, is written with this pid, and read back as a live app', async () => {
    const dir = await tempDir('astera-apppid-')
    expect(appPidFilePath(dir)).toBe(path.join(dir, 'app.pid'))
    expect(liveAppPid(dir)).toBeNull()
    markAppRunning(dir, process.pid)
    expect(readFileSync(appPidFilePath(dir), 'utf8')).toBe(String(process.pid))
    expect(liveAppPid(dir)).toBe(process.pid)
  })
  it('reads a pid whose process has ended, or a file that is not one pid, as no app', async () => {
    const dir = await tempDir('astera-apppid-')
    writeFileSync(appPidFilePath(dir), String(await dead()))
    expect(liveAppPid(dir)).toBeNull()
    for (const text of ['', 'abc', '0', '-4', '1.5', `${process.pid} 7`]) {
      writeFileSync(appPidFilePath(dir), text)
      expect(liveAppPid(dir), text).toBeNull()
    }
  })
  it('is removed on a clean quit, but not when it names another app', async () => {
    const dir = await tempDir('astera-apppid-')
    markAppRunning(dir, process.pid)
    clearAppRunning(dir, process.pid + 1)
    expect(existsSync(appPidFilePath(dir))).toBe(true)
    clearAppRunning(dir, process.pid)
    expect(existsSync(appPidFilePath(dir))).toBe(false)
    clearAppRunning(dir, process.pid)
  })
  it('never throws, even with no profile folder', () => {
    const nowhere = path.join(tmpdir(), `astera-apppid-missing-${process.pid}`, 'deeper')
    expect(() => markAppRunning(nowhere, process.pid)).not.toThrow()
    expect(() => clearAppRunning(nowhere, process.pid)).not.toThrow()
    expect(liveAppPid(nowhere)).toBeNull()
  })
})
