import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SlackConfigStore } from './slackConfigStore'
import type { SlackConfig } from '../core/slack/config'
import { isSlackReady } from '../core/slack/ready'

/** 설정 한 벌을 만든다 — 지정하지 않은 필드는 null. SlackConfig에 필드가 늘 때마다 아래 테스트들의
 *  save()/toEqual()을 전부 손대야 하는 것을 막는다(실제로 겪었다).
 *  toEqual은 여전히 완전 비교다 — 헬퍼가 모든 필드를 채우기 때문이다. */
const cfg = (over: Partial<SlackConfig> = {}): SlackConfig => ({
  webhookUrl: null,
  botToken: null,
  channelId: null,
  appToken: null,
  memberId: null,
  ...over
})

describe('SlackConfigStore', () => {
  it('저장 후 로드 왕복, 빈 문자열은 null로 정규화, 파일 없음/손상은 기본값', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slack-'))
    try {
      const store = new SlackConfigStore(path.join(dir, 'slack.json'))
      expect(await store.load()).toEqual(cfg()) // 파일 없음
      await store.save(cfg({ webhookUrl: 'https://hooks.slack.com/x' }))
      expect(await store.load()).toEqual(cfg({ webhookUrl: 'https://hooks.slack.com/x' }))
      await store.save(cfg())
      expect(await store.load()).toEqual(cfg())
      await fs.writeFile(path.join(dir, 'slack.json'), '{broken', 'utf8')
      expect(await store.load()).toEqual(cfg()) // 손상
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('SlackConfigStore 확장 (봇 토큰·채널·appToken)', () => {
  it('botToken·channelId·appToken을 저장하고 다시 읽는다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    await store.save(
      cfg({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-1' })
    )

    expect(await store.load()).toEqual(
      cfg({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-1' })
    )
  })

  it('파일이 없으면 전부 null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-'))
    const store = new SlackConfigStore(path.join(dir, 'none.json'))

    expect(await store.load()).toEqual(cfg())
  })

  it('기존 webhookUrl만 있는 파일도 읽힌다 (하위 호환)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-'))
    const file = path.join(dir, 'slack.json')
    await fs.writeFile(file, JSON.stringify({ webhookUrl: 'https://hooks/old' }), 'utf8')

    expect(await new SlackConfigStore(file).load()).toEqual(cfg({ webhookUrl: 'https://hooks/old' }))
  })

  it('봇 토큰·채널만 있고 appToken이 없는 파일도 읽힌다 (옛 설정과의 하위 호환)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-'))
    const file = path.join(dir, 'slack.json')
    await fs.writeFile(file, JSON.stringify({ botToken: 'xoxb-old', channelId: 'C-old' }), 'utf8')

    expect(await new SlackConfigStore(file).load()).toEqual(
      cfg({ botToken: 'xoxb-old', channelId: 'C-old' })
    )
  })

  it('빈 문자열은 null로 정규화한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    await store.save(cfg({ webhookUrl: '  ', botToken: '', channelId: 'C1', appToken: '   ' }))

    expect(await store.load()).toEqual(cfg({ channelId: 'C1' }))
  })
})

describe('SlackConfigStore.patch', () => {
  it('보내지 않은 필드(undefined)는 기존 값을 보존한다 — 웹훅 저장이 봇 토큰을 지우지 않는다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1' }))

    // 한 필드만 보내는 호출이 회귀의 재현이다 — 나머지가 살아남아야 한다.
    const result = await store.patch({ webhookUrl: 'https://hooks.slack.com/new' })

    expect(result).toEqual(
      cfg({ webhookUrl: 'https://hooks.slack.com/new', botToken: 'xoxb-1', channelId: 'C1' })
    )
    expect(await store.load()).toEqual(result) // 디스크에도 병합된 값이 저장됐다
  })

  it('명시적으로 null을 보낸 필드는 지운다 — undefined(미전송)와 null(명시적 삭제)을 구별한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1' }))

    const result = await store.patch({ botToken: null })

    expect(result).toEqual(cfg({ webhookUrl: 'https://hooks/x', channelId: 'C1' }))
  })

  it('파일이 없는 상태에서 patch()는 빈 기본값을 기준으로 병합한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'none.json'))

    const result = await store.patch({ channelId: 'C9' })

    expect(result).toEqual(cfg({ channelId: 'C9' }))
  })

  // 파일이 있는데 읽히지 않는 경우가 값을 잃을 수 있는 유일한 길이다. load()는 앱을 막지 않으려고 전부
  // null로 폴백하는데, patch()가 그 폴백 위에 병합하면 디스크에 살아 있는 토큰이 한 번의 저장으로 null이
  // 된다. 읽기만 실패하고 쓰기는 되는 상태가 재현 조건이므로(Windows의 EPERM·EBUSY, fd 부족의 EMFILE 같은
  // 일시적 실패) readFile을 직접 실패시킨다 — 경로 자체를 못 쓰게 만들면 save()도 같이 실패해서 테스트가
  // 엉뚱한 이유로 통과한다.
  it('읽기가 실패하면(파일 없음이 아니라) 저장하지 않고 던진다 — 살아 있는 값을 null로 덮지 않는다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const file = path.join(dir, 'slack.json')
    const store = new SlackConfigStore(file)
    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-1' }))
    const onDisk = await fs.readFile(file, 'utf8')

    const spy = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    try {
      await expect(store.patch({ webhookUrl: 'https://hooks/new' })).rejects.toThrow(/slack\.json/)
    } finally {
      spy.mockRestore()
    }

    expect(await fs.readFile(file, 'utf8')).toBe(onDisk) // 토큰은 그대로 남아 있다
  })

  it('읽기 실패는 load()를 막지 않는다 — 기본값으로 폴백해 앱은 계속 뜬다', async () => {
    const spy = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    try {
      expect(await new SlackConfigStore('whatever/slack.json').load()).toEqual(cfg())
    } finally {
      spy.mockRestore()
    }
  })

  // 손상된 파일은 읽기 실패와 달리 다시 시도해도 되돌아오지 않는다. 여기서도 던지면 설정 화면에서 고칠 길이
  // 없어지므로 덮어쓰기를 허용한다 — 잃을 값이 애초에 없다.
  it('손상된 파일은 patch()로 덮어쓸 수 있다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const file = path.join(dir, 'slack.json')
    await fs.writeFile(file, '{broken', 'utf8')
    const store = new SlackConfigStore(file)

    const result = await store.patch({ channelId: 'C9' })

    expect(result).toEqual(cfg({ channelId: 'C9' }))
    expect(await store.load()).toEqual(result)
  })

  it('빈 객체로 patch()해도 기존 값이 그대로 유지된다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1' }))

    const result = await store.patch({})

    expect(result).toEqual(cfg({ webhookUrl: 'https://hooks/x', botToken: 'xoxb-1', channelId: 'C1' }))
  })

  it('appToken만 갱신해도 봇 토큰·채널이 보존된다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1' }))

    const result = await store.patch({ appToken: 'xapp-9' })

    expect(result).toEqual(cfg({ botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-9' }))
  })

  it('appToken은 전송 경로 선택에 영향을 주지 않는다 — 봇 판정은 botToken+channelId만 본다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-patch-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    // appToken만 있으면 봇 모드가 아니다 — isSlackReady도 false여야 한다
    const onlyApp = await store.patch({ appToken: 'xapp-1' })
    expect(isSlackReady(onlyApp)).toBe(false)

    // 봇 토큰+채널이 채워지면 appToken 유무와 무관하게 준비 완료다
    const withBot = await store.patch({ botToken: 'xoxb-1', channelId: 'C1' })
    expect(isSlackReady(withBot)).toBe(true)
  })
})

describe('SlackConfigStore — memberId', () => {
  it('memberId를 저장하고 다시 읽는다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1', memberId: 'U-owner' }))

    expect(await store.load()).toEqual(
      cfg({ botToken: 'xoxb-1', channelId: 'C1', memberId: 'U-owner' })
    )
  })

  it('memberId가 없는 옛 파일은 null로 읽힌다 — 마이그레이션 없이 차단 쪽으로 수렴한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const file = path.join(dir, 'slack.json')
    await fs.writeFile(
      file,
      JSON.stringify({ botToken: 'xoxb-old', channelId: 'C-old', appToken: 'xapp-old' }),
      'utf8'
    )

    expect(await new SlackConfigStore(file).load()).toEqual(
      cfg({ botToken: 'xoxb-old', channelId: 'C-old', appToken: 'xapp-old' })
    )
  })

  it('공백만 있는 memberId는 null로 정규화한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    await store.save(cfg({ channelId: 'C1', memberId: '   ' }))

    expect(await store.load()).toEqual(cfg({ channelId: 'C1' }))
  })

  it('memberId만 갱신해도 토큰·채널이 보존된다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-1' }))

    const result = await store.patch({ memberId: 'U-owner' })

    expect(result).toEqual(
      cfg({ botToken: 'xoxb-1', channelId: 'C1', appToken: 'xapp-1', memberId: 'U-owner' })
    )
  })

  it('다른 필드만 patch해도 memberId는 살아남는다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))
    await store.save(cfg({ botToken: 'xoxb-1', channelId: 'C1', memberId: 'U-owner' }))

    const result = await store.patch({ appToken: 'xapp-9' })

    expect(result.memberId).toBe('U-owner')
  })

  it('memberId는 전송 경로 선택에 영향을 주지 않는다 — 수신 권한이지 전송 조건이 아니다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-slackcfg-member-'))
    const store = new SlackConfigStore(path.join(dir, 'slack.json'))

    // memberId만 있으면 보낼 경로가 없다
    const onlyMember = await store.patch({ memberId: 'U-owner' })
    expect(isSlackReady(onlyMember)).toBe(false)

    // 봇 토큰+채널이 채워지면 memberId를 지워도 전송은 준비 완료다 (답장 주입만 막힌다)
    const withBot = await store.patch({ botToken: 'xoxb-1', channelId: 'C1', memberId: null })
    expect(isSlackReady(withBot)).toBe(true)
  })
})
