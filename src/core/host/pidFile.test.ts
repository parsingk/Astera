import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { hostPidFilePath, parseHostPidFile, serializeHostPidFile } from './pidFile'

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
