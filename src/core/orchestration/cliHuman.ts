// 사람이 읽는 출력 (공개 CLI 설계 §6).
//
// **순수하다.** 받는 것은 봉투 안의 `data` 이고 돌려주는 것은 글자뿐이다 — 프로세스도 TTY 도
// 모른다. 무엇을 보여 줄지 정하는 것과 언제 보여 줄지 정하는 것은 다른 일이고, 뒤쪽은 run.ts 가 한다.
//
// **스크립트는 이것을 읽으면 안 된다**(명세 §23). 그래서 이 모양에는 계약이 없다 — 칸이 늘고
// 너비가 바뀌는 것이 정상이다. 기계가 읽을 것은 `--json` 의 봉투다.

/** 상태 한 낱말. **파생값과 플래그를 한 낱말로 접는다** — 사람이 목록에서 훑는 것이 이것이고,
 *  훑으려면 한 칸에 있어야 한다.
 *
 *  순서가 뜻이다. 멈춘 것이 먼저다(사람이 세워 둔 것은 그 사실이 다른 무엇보다 앞선다), 그다음이
 *  예약(계획 자신은 돌지 않는다), 그다음이 사람을 기다리는 상태, 마지막이 Task 에서 나온 결과. */
export function stateWord(o: {
  outcome?: string
  questionsOpen?: number
  paused?: boolean
  pendingStart?: boolean
  schedule?: unknown
}): string {
  if (o.pendingStart === true) return 'PENDING'
  if (o.paused === true) return 'PAUSED'
  if (o.schedule !== undefined && o.schedule !== null) return 'SCHEDULED'
  if ((o.questionsOpen ?? 0) > 0) return 'WAITING'
  if (o.outcome === 'completed') return 'COMPLETE'
  if (o.outcome === 'failed') return 'FAILED'
  if (o.outcome === 'running') return 'RUNNING'
  return '-'
}

/** 마지막 칸. 사람을 기다리는 중이면 그 수가 진행률보다 급한 소식이다(설계 §6 의 예시). */
function progressWord(o: { questionsOpen?: number; progress?: { done: number; total: number } }): string {
  const open = o.questionsOpen ?? 0
  if (open > 0) return open === 1 ? '1 question' : `${open} questions`
  const p = o.progress
  return p ? `${p.done}/${p.total}` : ''
}

/**
 * 칸을 맞춘 표. 테두리는 없다 — 터미널에서 잘라 붙이는 것이 사람이 이 출력으로 하는 일이고,
 * 테두리는 그때 방해만 된다.
 *
 * **마지막 칸은 채우지 않는다.** 채우면 눈에 보이지 않는 공백이 줄 끝에 남아, 복사한 값이
 * 조용히 달라진다.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd]
]

/**
 * 터미널이 그 글자를 몇 칸으로 그리는가.
 *
 * **`length` 를 쓰면 한글 목록의 칸이 어긋난다.** 자바스크립트의 길이는 UTF-16 단위의 수고,
 * 한글·한자·가나는 한 글자가 두 칸이다 — 이 저장소의 Job 이름이 대개 한글이므로, 칸을
 * 맞추려는 모드가 바로 그 자리에서 틀어진다.
 *
 * 표는 East Asian Width 의 W·F 대역이다. 전시를 옮기지 않고 이 앱이 실제로 보여 주는 글자
 * — 한글, 한자, 가나, 전각 기호, 이모지 — 를 덮는다. 빠진 글자는 한 칸으로 세어 그 줄만 좀
 * 좁게 보일 뿐이다.
 */
export function displayWidth(text: string): number {
  let w = 0
  // 코드포인트로 돌진다 — 이모지는 UTF-16 두 칸을 차지하면서 한 글자다.
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    w += WIDE.some(([a, b]) => c >= a && c <= b) ? 2 : 1
  }
  return w
}

const padTo = (cell: string, to: number): string =>
  cell + ' '.repeat(Math.max(0, to - displayWidth(cell)))

export function columns(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return ''
  const width: number[] = []
  for (const row of rows)
    row.forEach((cell, i) => {
      if (i < row.length - 1) width[i] = Math.max(width[i] ?? 0, displayWidth(cell))
    })
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i < row.length - 1 ? padTo(cell, width[i] ?? 0) : cell))
        .join('  ')
        .trimEnd()
    )
    .join('\n')
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v))

/** 한 개체를 이름과 값의 줄로. **목록을 따로 두지 않는다** — 무엇을 내보낼지는 가림막이 이미
 *  정했고(cliPublic.ts), 여기서 또 고르면 두 곳이 갈라진다. */
function fields(o: Record<string, unknown>): string {
  return columns(
    Object.entries(o).map(([k, v]) => [
      k,
      // 진행은 사람이 가장 자주 읽는 값이다 — 목록과 같은 모양으로 낸다.
      k === 'progress' && v !== null && typeof v === 'object'
        ? `${str((v as { done?: unknown }).done)}/${str((v as { total?: unknown }).total)}`
        : v !== null && typeof v === 'object'
          ? JSON.stringify(v)
          : str(v)
    ])
  )
}

const indent = (text: string): string =>
  text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')

const asList = (data: Record<string, unknown>, key: string): Record<string, unknown>[] => {
  const v = data[key]
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : []
}

/**
 * 그 명령의 사람용 출력. **모르는 명령은 null 이다** — 부르는 쪽이 JSON 으로 되돌린다. 공개
 * 표면이 아닌 명령(코디네이터의 것들)에 억지로 표를 씌우면 가이드가 시키는 것을 못 읽게 된다.
 */
export function humanFor(cmd: string, data: Record<string, unknown>): string | null {
  switch (cmd) {
    case 'projects-list':
      return columns(asList(data, 'projects').map((p) => [str(p.id), str(p.name), str(p.path)]))
    case 'jobs-list':
      return columns(
        asList(data, 'jobs').map((j) => [
          stateWord(j),
          str(j.id),
          str(j.objective),
          progressWord(j)
        ])
      )
    case 'runs-list':
      return columns(
        asList(data, 'runs').map((r) => [
          stateWord(r),
          str(r.id),
          str(r.jobId),
          `#${str(r.ordinal)}`,
          progressWord(r)
        ])
      )
    case 'tasks-list':
      return columns(
        asList(data, 'tasks').map((t) => [
          String(t.status ?? '-').toUpperCase(),
          str(t.id),
          str(t.title)
        ])
      )
    // One row per Task, and under a row that failed, what failed: that line is what a person reads
    // this command for, and a table cell would cut it.
    case 'runs-checks': {
      const tasks = asList(data, 'tasks')
      if (tasks.length === 0) return `(no tasks in ${str(data.runId)})`
      const standing = (v: unknown): string =>
        v !== null && typeof v === 'object' ? str((v as { status?: unknown }).status) : ''
      const table = columns(
        tasks.map((t) => [
          String(t.status ?? '-').toUpperCase(),
          str(t.id),
          `validation ${standing(t.validation)}`,
          `review ${standing(t.review)}`,
          str(t.title)
        ])
      ).split('\n')
      return tasks
        .flatMap((t, i) => [table[i], ...(typeof t.failureSummary === 'string' ? [`  ${t.failureSummary}`] : [])])
        .join('\n')
    }
    case 'questions-list':
      return columns(
        asList(data, 'questions').map((q) => [
          String(q.status ?? '-').toUpperCase(),
          str(q.id),
          str(q.taskId),
          str(q.question)
        ])
      )
    case 'accounts-list':
      return columns(
        asList(data, 'accounts').map((a) => [str(a.id), str(a.provider), str(a.label)])
      )
    case 'run-configs-list':
      return columns(
        asList(data, 'runConfigs').map((c) => [str(c.id), str(c.type), str(c.name)])
      )
    case 'sessions-list':
      return columns(
        asList(data, 'sessions').map((x) => [
          x.alive === true ? 'ALIVE' : 'ENDED',
          str(x.state),
          str(x.id),
          str(x.kind),
          str(x.title)
        ])
      )
    // 프롬프트 하나에 한 줄. 앱에 묻지 못했으면 목록이 짧을 수 있다고 표 아래에 적는다 — 빈 목록이
    // "열린 것이 없다" 로 읽히면 안 된다.
    case 'chats-pending': {
      const rows = asList(data, 'prompts').map((x) => [str(x.sessionId), str(x.id), str(x.kind), str(x.tool), str(x.summary)])
      const short = data.complete === false ? ['Astera could not be asked, so this list may be short'] : []
      if (rows.length === 0) return short.length > 0 ? short[0] : '(no open prompts)'
      return [columns(rows), ...short].join('\n')
    }
    // 읽으라고 부른 화면이다 — 표로 싸면 사람이 읽으려던 것을 가린다.
    // 위의 줄들이 먼저, 그 아래 화면 — 터미널에서 보던 순서다.
    // 대화 세션은 화면이 아니라 턴이다 — 누가 말했는지 줄을 세우고, 글은 들여 쓰고, 도구는 한 줄씩.
    // 열린 카드는 맨 끝이다: 사람이 그 세션에서 가장 먼저 알아야 할 것이 거기 있다.
    case 'sessions-read': {
      if (data.kind !== 'chat') return [...asList(data, 'scrollback'), ...asList(data, 'screen')].map(str).join('\n')
      const turns = asList(data, 'turns').map((t) =>
        [
          `${str(t.role)}:`,
          ...(str(t.text) === '' ? [] : [str(t.text).split('\n').map((l) => (l === '' ? '' : `  ${l}`)).join('\n')]),
          ...(Array.isArray(t.tools) ? (t.tools as unknown[]).map((x) => `  [tool] ${str(x)}`) : [])
        ].join('\n')
      )
      const p = data.pending !== null && typeof data.pending === 'object' ? (data.pending as Record<string, unknown>) : null
      const tail = p === null ? [] : [`waiting on ${p.kind === 'approval' ? 'an approval' : 'a question'}: ${str(p.summary)}`]
      const body = [...turns, ...tail]
      return body.length === 0 ? '(no turns yet)' : body.join('\n\n')
    }
    // 계정×스킬 한 줄씩. install 은 설정이 꺼져 심지 않은 것과 그것을 켜는 설정, 그리고 이미 열린
    // 세션은 새 스킬을 못 본다는 한 줄을 표 아래에 붙인다(cli/skills.ts).
    case 'skills-list':
    case 'skills-install': {
      const rows = asList(data, 'accounts').flatMap((a) =>
        asList(a, 'skills').map((s) =>
          cmd === 'skills-list'
            ? [str(a.id), str(a.provider), str(s.name), s.enabled === true ? 'on' : 'off', str(s.installed)]
            : [str(a.id), str(a.provider), str(s.name), str(s.result)]
        )
      )
      const off = asList(data, 'notEnabled')
      return [
        rows.length === 0 ? 'no accounts' : columns(rows),
        ...(off.length === 0
          ? []
          : ['', 'not enabled:', ...columns(off.map((n) => [str(n.name), str(n.setting)])).split('\n').map((l) => `  ${l}`)]),
        ...(typeof data.note === 'string' ? ['', data.note] : [])
      ].join('\n')
    }
    // 접어 실은 회차를 한 줄 JSON 으로 내면 읽으라고 만든 모드가 읽힐 수 없게 된다.
    case 'jobs-get': {
      const { run, ...job } = data
      const head = fields(job)
      return run !== null && typeof run === 'object'
        ? `${head}\n\nrun\n${indent(fields(run as Record<string, unknown>))}`
        : head
    }
    /**
     * **시한이 지난 `ask` 만 사람의 문장이 된다.**
     *
     * 답이 온 `ask` 는 `null` 로 떨어져 예전처럼 봉투로 나간다 — 그 답을 읽는 것은 워커이고,
     * 워커가 읽는 것은 JSON 이다. 시한이 지난 쪽만 다른 이유는 그 답이 **실패처럼 보이기**
     * 때문이다: 아무 일도 일어나지 않은 채 돌아온 명령을 사람도 에이전트도 "안 됐다" 로 읽고
     * 다시 묻는다. 기계가 읽을 줄은 `data.nextSteps` 가 싣고(cliOutput 의 askTimeoutBody),
     * 여기서는 같은 줄에 왜인지를 한 문장 붙인다 — 두 모드가 다른 말을 하지 않도록 문장도
     * 그 칸에서 만든다.
     */
    case 'ask': {
      if (data.timedOut !== true) return null
      const steps = Array.isArray(data.nextSteps)
        ? (data.nextSteps as unknown[]).filter((s): s is string => typeof s === 'string')
        : []
      const head = 'the deadline passed and the question is still open'
      if (steps.length === 0) {
        // `but` 로 잇는다 — 그 칸의 문장은 소문자로 시작하는 절이고(cliOutput 의 두 상수), 마침표
        // 뒤에 그대로 붙이면 문장이 소문자로 시작한다.
        const why =
          typeof data.cannotResume === 'string' ? data.cannotResume : 'it cannot be resumed safely'
        return `${head}, but ${why}`
      }
      return [`${head}. Do not ask again; keep waiting:`, ...steps.map((s) => `  ${s}`)].join('\n')
    }
    // 잘 끝난 때만 여기까지 온다 — 나머지 끝은 종료 코드와 한 줄로 나간다(run.ts).
    case 'jobs-wait':
    case 'runs-wait':
    case 'projects-get':
    case 'projects-find':
    case 'runs-get':
    case 'questions-get':
    case 'jobs-create':
    case 'tasks-add':
    case 'sessions-send':
    case 'chats-answer':
    case 'status':
    case 'version':
    case 'host-status':
    case 'host-start':
    case 'host-stop':
      return fields(data)
    default:
      return null
  }
}

/** `--quiet` — id 만, 한 줄에 하나. `for j in $(astera jobs list --quiet)` 가 jq 없이 돌게 한다.
 *
 *  **id 가 없으면 아무것도 내지 않는다.** status 나 version 처럼 id 가 없는 답이 있고, 그때
 *  없는 것을 지어내는 것보다 빈 줄이 정직하다. */
export function quietFor(data: Record<string, unknown>): string {
  const ids: string[] = []
  const take = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return
    const id = (v as { id?: unknown }).id
    if (typeof id === 'string') ids.push(id)
  }
  for (const v of Object.values(data)) {
    if (Array.isArray(v)) v.forEach(take)
  }
  if (ids.length === 0) take(data)
  return ids.join('\n')
}
