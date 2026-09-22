import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  claudeConfigFileFor,
  claudeProjectKey,
  markClaudeProjectTrusted,
  upsertClaudeTrust
} from './claudeTrust'

describe('claudeProjectKey', () => {
  // 실제 파일에서 읽은 규칙이다 — 다른 철자로 적은 항목은 claude 가 찾지 못하는 항목이다
  it('정슬래시·대문자 드라이브·끝 구분자 없음', () => {
    expect(claudeProjectKey('C:\\Users\\me\\wt\\a')).toBe('C:/Users/me/wt/a')
    expect(claudeProjectKey('c:/users/me/wt/a/')).toBe('C:/users/me/wt/a')
    expect(claudeProjectKey('/home/me/wt/a')).toBe('/home/me/wt/a')
  })
})

describe('claudeConfigFileFor', () => {
  // **ambient 계정의 상태는 홈 루트에 있다.** 설정 폴더 아래에 쓰면 claude 가 열지 않는 파일에 쓴다
  it('ambient 계정은 홈 루트다', () => {
    expect(
      claudeConfigFileFor({ configDir: '/home/me/.claude', homeDir: '/home/me', ambient: true })
    ).toBe(path.join('/home/me', '.claude.json'))
  })

  it('격리 계정은 그 폴더 아래다', () => {
    expect(
      claudeConfigFileFor({ configDir: '/home/me/.claude-accounts/b', homeDir: '/home/me', ambient: false })
    ).toBe(path.join('/home/me/.claude-accounts/b', '.claude.json'))
  })
})

describe('upsertClaudeTrust', () => {
  it('없던 프로젝트에 항목을 만든다', () => {
    const out = JSON.parse(upsertClaudeTrust('{"projects":{}}', 'C:\\wt\\a'))
    expect(out.projects['C:/wt/a'].hasTrustDialogAccepted).toBe(true)
  })

  // 134KB 짜리 남의 파일이다 — 하나를 더하는 일이 나머지를 건드리면 안 된다
  it('다른 모든 것을 보존한다', () => {
    const before = {
      numStartups: 810,
      oauthAccount: { emailAddress: 'x@y.z' },
      projects: {
        'D:/other': { hasTrustDialogAccepted: true, lastGracefulShutdown: false },
        'D:/third': { hasTrustDialogAccepted: false }
      }
    }
    const out = JSON.parse(upsertClaudeTrust(JSON.stringify(before, null, 2), 'D:/new'))
    expect(out.numStartups).toBe(810)
    expect(out.oauthAccount).toEqual({ emailAddress: 'x@y.z' })
    expect(out.projects['D:/other']).toEqual({ hasTrustDialogAccepted: true, lastGracefulShutdown: false })
    expect(out.projects['D:/third']).toEqual({ hasTrustDialogAccepted: false })
    expect(out.projects['D:/new']).toEqual({ hasTrustDialogAccepted: true })
  })

  it('그 프로젝트의 다른 칸은 남긴다', () => {
    const before = { projects: { 'D:/a': { lastGracefulShutdown: true, history: [1, 2] } } }
    const out = JSON.parse(upsertClaudeTrust(JSON.stringify(before), 'D:/a'))
    expect(out.projects['D:/a']).toEqual({
      lastGracefulShutdown: true,
      history: [1, 2],
      hasTrustDialogAccepted: true
    })
  })

  // 두 항목이 한 폴더를 가리키면 그 파일의 뜻은 claude 가 어느 것을 읽는지에 달린다
  it('철자가 다른 기존 항목을 중복하지 않는다', () => {
    const before = { projects: { 'C:/Users/Me/WT': { hasTrustDialogAccepted: false } } }
    const out = JSON.parse(upsertClaudeTrust(JSON.stringify(before), 'c:\\users\\me\\wt'))
    expect(Object.keys(out.projects)).toEqual(['C:/Users/Me/WT'])
    expect(out.projects['C:/Users/Me/WT'].hasTrustDialogAccepted).toBe(true)
  })

  // 같은 문자열을 돌려주는 것이 부르는 쪽이 쓰기를 건너뛰는 근거다
  it('이미 신뢰면 입력과 같은 문자열이다', () => {
    const src = JSON.stringify({ projects: { 'D:/a': { hasTrustDialogAccepted: true } } }, null, 2)
    expect(upsertClaudeTrust(src, 'D:/a')).toBe(src)
    expect(upsertClaudeTrust(src, 'd:\\a')).toBe(src)
  })

  it('빈 파일과 BOM 을 받는다', () => {
    expect(JSON.parse(upsertClaudeTrust('', 'D:/a')).projects['D:/a'].hasTrustDialogAccepted).toBe(true)
    const bom = '\ufeff' + JSON.stringify({ projects: {} })
    expect(JSON.parse(upsertClaudeTrust(bom, 'D:/a')).projects['D:/a'].hasTrustDialogAccepted).toBe(true)
  })

  // 한 줄로 눌러 버리면 남의 134KB 파일이 통째로 다른 모양이 된다
  it('들여쓰기를 그 파일에서 가져온다', () => {
    const two = JSON.stringify({ projects: {} }, null, 2)
    expect(upsertClaudeTrust(two, 'D:/a')).toContain('\n  "projects"')
    const flat = JSON.stringify({ projects: {} })
    expect(upsertClaudeTrust(flat, 'D:/a')).not.toContain('\n')
  })
})

describe('markClaudeProjectTrusted', () => {
  const tmpDir = async (): Promise<string> =>
    fs.mkdtemp(path.join(os.tmpdir(), 'claude-trust-'))

  it('파일이 없으면 만든다', async () => {
    const dir = await tmpDir()
    const file = path.join(dir, '.claude.json')
    await markClaudeProjectTrusted(file, 'D:/wt/a')
    const out = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(out.projects['D:/wt/a'].hasTrustDialogAccepted).toBe(true)
  })

  // 실패가 반쯤 쓴 config 를 남기면 claude 가 그것을 믿는다
  it('쓰기 전에 .bak 을 남긴다', async () => {
    const dir = await tmpDir()
    const file = path.join(dir, '.claude.json')
    const before = JSON.stringify({ numStartups: 5, projects: {} }, null, 2)
    await fs.writeFile(file, before, 'utf8')
    await markClaudeProjectTrusted(file, 'D:/wt/a')
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe(before)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).numStartups).toBe(5)
  })

  // 이미 신뢰인 워크트리에 워커가 또 뜰 때마다 남의 파일을 다시 쓰지 않는다
  it('이미 신뢰면 아무것도 쓰지 않는다', async () => {
    const dir = await tmpDir()
    const file = path.join(dir, '.claude.json')
    await fs.writeFile(file, JSON.stringify({ projects: { 'D:/a': { hasTrustDialogAccepted: true } } }), 'utf8')
    await markClaudeProjectTrusted(file, 'D:/a')
    await expect(fs.readFile(file + '.bak', 'utf8')).rejects.toThrow()
  })
})
