// **저하 경로가 이 파일의 요점이다.** 목록을 못 받는 것은 예외가 아니라 정상 경로다 — 로그아웃된
// claude, experimental 인 codex `app-server`, 아예 설치되지 않은 CLI. 그때 설정 화면은 드롭다운
// 대신 자유 입력칸과 사유를 보여 주므로, 여기서 던지면 그 사유가 사라진다.
//
// **가짜 CLI 를 진짜로 띄운다.** spawn 을 흉내 내지 않는 이유는 이 파일의 위험이 프로세스에 있기
// 때문이다: win32 의 `.cmd` 셰임은 shell 없이 spawn 하면 EINVAL 이고, 그래서 `cmd.exe /c` 로
// 감싼다. 그 감싸기를 지나지 않는 테스트는 이 파일에서 가장 잘 깨지는 부분을 보지 않는다.
//
// 가짜에게 무엇을 하라고 이르는 통로는 **설정 디렉터리 인자**다 — 인자 벡터는 이 파일이 고정하고
// 있어 손댈 수 없지만, `CLAUDE_CONFIG_DIR`/`CODEX_HOME` 은 부르는 쪽이 정한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listClaudeModels, listCodexModels } from './discover'

/** 이 파일의 테스트마다 주는 시간. 기본값(10초)보다 길게 잡는 이유는 여기서 재는 것이 코드가
 *  아니라 **프로세스 시작**이기 때문이다 — win32 에서는 `cmd.exe` 와 node 를 차례로 띄우고,
 *  전체 스위트와 함께 도는 동안에는 그 시작만으로 10초에 닿을 수 있다. 조회 자체의 한도는
 *  discover.ts 가 따로 쥐고 있다(20초). */
const T = 40_000

let dir: string
let cli: string

const FAKE = `
const mode = process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || ''
if (mode === 'die') {
  process.stderr.write('not logged in\\n')
  process.exit(3)
}
let buf = ''
process.stdin.on('data', (d) => {
  buf += d.toString('utf8')
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    if (msg.type === 'control_request') {
      if (mode === 'reject') say({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'error', error: 'nope' } })
      else if (mode === 'empty') say({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'success', response: { models: [] } } })
      else if (mode === 'noise') { say({ type: 'system', subtype: 'init' }); say({ type: 'control_response', response: { request_id: 'someone-else', subtype: 'success', response: { models: [] } } }); process.exit(0) }
      else say({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'success', response: { models: [
        { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', description: 'd', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }
      ] } } })
    } else if (msg.method === 'model/list') {
      if (mode === 'reject') say({ id: msg.id, error: { code: -32601, message: 'no such method' } })
      else say({ id: msg.id, result: { data: [
        { id: 'gpt-5.6', model: 'gpt-5.6', displayName: 'GPT 5.6', description: 'd',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }
      ] } })
    } else if (msg.method === 'initialize') {
      say({ id: msg.id, result: {} })
    }
  }
})
`

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-models-'))
  await fs.writeFile(path.join(dir, 'fake.js'), FAKE, 'utf8')
  // 감싸기를 그대로 지나게 한다: win32 는 cmd.exe 가 실행할 수 있는 셰임, 그 밖에는 실행 비트를
  // 준 sh 스크립트. 둘 다 인자를 버린다 — 이 파일이 고정해 보내는 인자는 진짜 CLI 의 것이라
  // node 가 읽으면 죽는다
  if (process.platform === 'win32') {
    cli = path.join(dir, 'fake.cmd')
    await fs.writeFile(cli, `@"${process.execPath}" "%~dp0fake.js"\r\n`, 'utf8')
  } else {
    cli = path.join(dir, 'fake.sh')
    await fs.writeFile(cli, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.js"\n`, 'utf8')
    await fs.chmod(cli, 0o755)
  }
})
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('listClaudeModels', () => {
  it('초기화 응답에서 모델을 읽는다 — 추론을 한 번도 돌리지 않는다', async () => {
    const r = await listClaudeModels(cli, 'ok')
    expect(r.error).toBeUndefined()
    expect(r.models.map((m) => m.id)).toEqual(['opus'])
    expect(r.models[0].effortLevels).toEqual(['low', 'high'])
  }, T)

  it('CLI 가 답하기 전에 죽으면 그 사유가 남는다 — 던지지 않는다', async () => {
    const r = await listClaudeModels(cli, 'die')
    expect(r.models).toEqual([])
    expect(r.error).toContain('not logged in')
  }, T)

  it('요청이 거절되면 로그인을 의심하라고 말한다', async () => {
    const r = await listClaudeModels(cli, 'reject')
    expect(r.models).toEqual([])
    expect(r.error).toContain('로그인')
  }, T)

  it('빈 목록도 사유가 있는 실패다 — 빈 드롭다운은 고장으로 읽힌다', async () => {
    expect((await listClaudeModels(cli, 'empty')).error).toBeTruthy()
  }, T)

  // 이 모드는 시스템 줄과 **남의 request_id** 로 온 성공 응답을 던지고 끝낸다. 그것을 자기 답으로
  // 착각하면 목록이 비어 있는 채로 성공한 것처럼 보인다 — 여기서는 답을 못 받고 끝난 것이 정답이다
  it('내가 보낸 요청의 답만 읽는다', async () => {
    const r = await listClaudeModels(cli, 'noise')
    expect(r.models).toEqual([])
    expect(r.error).toContain('종료')
  }, T)

  it('설치되지 않은 CLI 도 사유일 뿐이다', async () => {
    const r = await listClaudeModels(path.join(dir, '없는것'), 'ok')
    expect(r.models).toEqual([])
    expect(r.error).toBeTruthy()
  }, T)
})

describe('listCodexModels', () => {
  it('model/list 의 답을 읽는다', async () => {
    const r = await listCodexModels(cli, 'ok')
    expect(r.error).toBeUndefined()
    expect(r.models.map((m) => m.id)).toEqual(['gpt-5.6'])
    // 실측에서 이 배열은 문자열이 아니라 객체였다 — 그것을 놓치면 강도 칸이 조용히 사라진다
    expect(r.models[0].effortLevels).toEqual(['low', 'high'])
  }, T)

  it('app-server 가 그 메서드를 모르면 사유가 남는다 — experimental 이라 정상 경로다', async () => {
    const r = await listCodexModels(cli, 'reject')
    expect(r.models).toEqual([])
    expect(r.error).toContain('model/list')
  }, T)
})
