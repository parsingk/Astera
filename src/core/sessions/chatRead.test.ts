import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chatTurnOf, chatPendingOf, readChatTurns, CHAT_TURNS_MAX } from './chatRead'
import { findClaudeTranscript } from '../history/strategies/claude'

const FIXTURES = path.join(__dirname, '..', 'history', 'fixtures')

let dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'astera-chatread-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('chatTurnOf — 대화 화면의 턴 하나를 CLI 가 싣는 모양으로', () => {
  it('글은 이어 붙이고, 도구는 한 줄씩 결과와 함께 적는다', () => {
    expect(
      chatTurnOf({
        id: 'm1',
        role: 'assistant',
        parts: [
          { kind: 'text', text: '먼저 빌드 로그를 보겠습니다.' },
          { kind: 'tool', id: 'a', name: 'shell_command', target: 'npm run build', outcome: { ok: false, detail: 'exit 1' } },
          { kind: 'tool', id: 'b', name: 'apply_patch', target: 'src/a.ts', outcome: { ok: true, detail: '' } },
          { kind: 'tool', id: 'c', name: 'Read', target: 'src/b.ts', outcome: null },
          { kind: 'text', text: '고쳤습니다.' }
        ]
      })
    ).toEqual({
      role: 'assistant',
      text: '먼저 빌드 로그를 보겠습니다.\n\n고쳤습니다.',
      tools: ['shell_command npm run build (failed: exit 1)', 'apply_patch src/a.ts (ok)', 'Read src/b.ts']
    })
  })

  // 한 줄에 한 도구다 — heredoc 을 넘긴 Bash 의 대상은 여러 줄이다.
  it('여러 줄인 대상은 첫 줄만 남기고 줄였다고 표시한다', () => {
    const turn = chatTurnOf({
      id: 'm',
      role: 'assistant',
      parts: [{ kind: 'tool', id: 'a', name: 'Bash', target: "python - <<'PY'\nprint(1)\nPY", outcome: { ok: true, detail: '3 lines' } }]
    })
    expect(turn.tools).toEqual(["Bash python - <<'PY' … (ok: 3 lines)"])
    expect(turn.text).toBe('')
  })
})

describe('chatPendingOf — 열려 있는 카드를 한 줄로', () => {
  it('승인은 도구와 그 첫 줄이다', () => {
    expect(
      chatPendingOf({ id: 'r1', kind: 'approval', about: { tool: 'Bash', lines: ['npm test', 'Run the tests'] }, decisions: ['accept', 'decline'] })
    ).toEqual({ kind: 'approval', summary: 'Bash: npm test' })
  })

  it('질문은 첫 질문이고, 더 있으면 몇 개 더인지 적는다', () => {
    const q = (question: string) => ({ header: '', question, options: [{ label: 'a', description: null }, { label: 'b', description: null }], multiSelect: false })
    expect(chatPendingOf({ id: 'r2', kind: 'question', form: { questions: [q('어느 쪽으로?')] } })).toEqual({
      kind: 'question',
      summary: '어느 쪽으로?'
    })
    expect(chatPendingOf({ id: 'r3', kind: 'question', form: { questions: [q('하나'), q('둘'), q('셋')] } })).toEqual({
      kind: 'question',
      summary: '하나 (+2 more)'
    })
  })

  it('카드가 없으면 null', () => {
    expect(chatPendingOf(null)).toBeNull()
  })
})

describe('readChatTurns — 대화 화면이 읽는 그 파일과 그 reducer 로', () => {
  it('Claude 의 transcript 에서 최근 턴을 오래된 것부터 준다', async () => {
    const turns = await readChatTurns(path.join(FIXTURES, 'conversation-turn.jsonl'), 'claude', 20)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user'])
    expect(turns[0].text).toBe('설정 모달에서 정보 탭을 히스토리 아래에 두자.')
    expect(turns[1].tools).toHaveLength(10)
    expect(turns[1].tools[0]).toMatch(/^Bash grep -rn .* \(ok: 5 lines\)$/)
    expect(turns[1].text).toMatch(/^설정 모달 왼쪽 탭 목록에서/)
    expect(turns[2]).toEqual({ role: 'user', text: '일반으로 바꾸자', tools: [] })
  })

  it('Codex 의 rollout 은 rollout 의 reducer 로 읽는다', async () => {
    const turns = await readChatTurns(path.join(FIXTURES, 'codex-rollout.jsonl'), 'codex', 20)
    expect(turns).toEqual([
      { role: 'user', text: '빌드가 왜 깨지는지 봐줘', tools: [] },
      {
        role: 'assistant',
        text: '먼저 빌드 로그를 보겠습니다.\n\n타입이 안 맞습니다. 고치겠습니다.\n\n고쳤습니다. 빌드가 지나갑니다.',
        tools: ['shell_command npm run build (failed: exit 1)', 'apply_patch src/a.ts (ok)', 'web_search TS2345 meaning (ok)']
      },
      { role: 'user', text: '고마워', tools: [] }
    ])
  })

  it('--turns 만큼만, 가장 최근 것을 준다', async () => {
    const turns = await readChatTurns(path.join(FIXTURES, 'conversation-turn.jsonl'), 'claude', 1)
    expect(turns).toEqual([{ role: 'user', text: '일반으로 바꾸자', tools: [] }])
  })

  // 창 하나(256KB)에 다 들지 않는 대화도 요청한 만큼은 준다 — 창을 거슬러 올라간다.
  it('한 창에 다 들지 않으면 앞 창으로 거슬러 올라가 채운다', async () => {
    const file = path.join(tmp(), 'long.jsonl')
    const pad = 'x'.repeat(60 * 1024)
    const line = (i: number): string =>
      JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `질문 ${i} ${pad}` } }) + '\n'
    writeFileSync(file, '')
    for (let i = 0; i < 30; i++) appendFileSync(file, line(i))
    const turns = await readChatTurns(file, 'claude', 25)
    expect(turns).toHaveLength(25)
    expect(turns[0].text.startsWith('질문 5 ')).toBe(true)
    expect(turns[24].text.startsWith('질문 29 ')).toBe(true)
  })

  // 막 연 세션은 첫 턴 전까지 파일이 없다. 오류가 아니라 아직 아무 말도 없는 것이다.
  it('파일이 없으면 빈 목록이다', async () => {
    expect(await readChatTurns(path.join(tmp(), 'nope.jsonl'), 'claude', 20)).toEqual([])
  })

  it('상한은 200 이다', () => {
    expect(CHAT_TURNS_MAX).toBe(200)
  })
})

/** The rule the app finds a Claude chat session's transcript by (ipc.ts findClaudeChatTranscript →
 *  history's transcriptPathById → the Claude strategy's `locate`), now shared with the Host. */
describe('findClaudeTranscript', () => {
  it('<configDir>/projects/<slug>/<threadId>.jsonl 을 찾는다', async () => {
    const cfg = tmp()
    mkdirSync(path.join(cfg, 'projects', 'D--other'), { recursive: true })
    mkdirSync(path.join(cfg, 'projects', 'D--repo'), { recursive: true })
    const file = path.join(cfg, 'projects', 'D--repo', 'th-1.jsonl')
    copyFileSync(path.join(FIXTURES, 'conversation-turn.jsonl'), file)
    expect(await findClaudeTranscript(cfg, 'th-1')).toBe(file)
    expect(await findClaudeTranscript(cfg, 'th-2')).toBeNull()
  })

  it('projects 폴더가 없으면 null 이다', async () => {
    expect(await findClaudeTranscript(tmp(), 'th-1')).toBeNull()
  })

  // locate 가 buildEntry 로 거르던 것 — 사이드체인과 도우미 세션은 대화가 아니다.
  it('사이드체인 파일은 건너뛴다', async () => {
    const cfg = tmp()
    mkdirSync(path.join(cfg, 'projects', 'A'), { recursive: true })
    mkdirSync(path.join(cfg, 'projects', 'B'), { recursive: true })
    const main = readFileSync(path.join(FIXTURES, 'conversation-turn.jsonl'), 'utf8')
    writeFileSync(path.join(cfg, 'projects', 'A', 'th-1.jsonl'), main.replaceAll('"isSidechain":false', '"isSidechain":true'))
    writeFileSync(path.join(cfg, 'projects', 'B', 'th-1.jsonl'), main)
    expect(await findClaudeTranscript(cfg, 'th-1')).toBe(path.join(cfg, 'projects', 'B', 'th-1.jsonl'))
  })
})
