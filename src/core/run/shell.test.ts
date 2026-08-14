import { describe, it, expect } from 'vitest'
import { shellSpawn } from './shell'

describe('shellSpawn', () => {
  it('win32 는 명령을 문자열로 넘긴다 — 배열이면 node-pty 가 안쪽 따옴표를 망가뜨린다', () => {
    expect(shellSpawn('node "a b.js"', 'win32')).toEqual({
      file: 'cmd.exe',
      args: '/s /c "node "a b.js""'
    })
  })

  it('posix 는 배열 그대로다', () => {
    expect(shellSpawn('node "a b.js"', 'linux')).toEqual({
      file: 'sh',
      args: ['-c', 'node "a b.js"']
    })
  })
})
