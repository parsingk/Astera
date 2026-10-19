// A check's verdict in words, for the run's graph (a chip and its tooltip) and a Task's completion block (plugin Phase 5
// C13). One source, so the two never word a check differently; pure, so the node tests hold it.
import type { JobCheck } from '../../../core/types'
import type { NodeMeta } from '../../../core/orchestration/nodeMeta'
import type { MessageKey, MessageParams } from '../../../core/i18n'
import { formatRunDuration } from '../../../core/run/duration'
import { PLUGIN_CHECK_PREFIX } from '../../../core/orchestration/pluginChecks'
import type { CheckPluginRow } from '../lib/orchDoor'
import { statusLabel } from './pluginsText'

export type Translate = (key: MessageKey, params?: MessageParams) => string

/** 칩 기호의 종류 — CheckResult.status 다섯에 그리기 위한 여섯째 `retrying` 이 더해진다: validating 인 Task 에서
 *  지난 라운드에 막혔던 검사는 지금 다시 도는 중이라는 뜻이다(UI 설계 U12 — validator 는 라운드 끝에만 결과를
 *  주므로 "지금 도는 검사" 는 그렇게밖에 알 수 없다). */
export type GlyphKind = JobCheck['status'] | 'retrying'
// `error` (a plugin check that could not be made, plugin Phase 5 C9) draws apart from a failure.
export const GLYPH: Record<GlyphKind, string> = { passed: '✓', failed: '✗', 'timed-out': '✗', 'not-run': '○', error: '!', retrying: '●' }

/** A check's verdict: a command check's failure with its exit code, a plugin's without one (it has none), one that
 *  could not be made, and one a person let the round go on without. */
export function checkVerdict(c: { status: JobCheck['status']; exitCode?: number; skipped?: true }, t: Translate): string {
  switch (c.status) {
    case 'passed':
      return t('jobs.convergence.check.passed')
    case 'failed':
      return c.exitCode !== undefined ? t('jobs.convergence.check.failed', { code: c.exitCode }) : t('jobs.convergence.check.failedNoCode')
    case 'timed-out':
      return t('jobs.convergence.check.timedOut')
    case 'error':
      return t('jobs.convergence.check.error')
    case 'not-run':
      return c.skipped ? t('jobs.convergence.check.skipped') : t('jobs.convergence.check.notRun')
    default:
      // A status this app does not know (a Runtime of another version) is said as it is (5c final review)
      return String(c.status)
  }
}

/** "{이름} — {결과} ({지난 라운드 실제 시간}), {흔들림}". 시간은 formatRunDuration 을 빌린다 — {startedAt, exitedAt}
 *  과 now 를 받는 함수라 0·durationMs·0 을 넘긴다(어댑터 한 줄). */
export function checkTooltip(c: JobCheck, glyph: GlyphKind, t: Translate): string {
  const verdict = glyph === 'retrying' ? t('jobs.convergence.check.retrying') : checkVerdict(c, t)
  const time = c.durationMs !== undefined ? ` (${formatRunDuration({ startedAt: 0, exitedAt: c.durationMs }, 0)})` : ''
  const flip = c.unstable ? `, ${t('jobs.convergence.check.unstable')}` : ''
  return `${c.name} — ${verdict}${time}${flip}`
}

/** The checks the new-Task window offers (plugin Phase 5 C6): the run configurations, then this computer's check
 *  plugins as "Plugin: <name>", one that is not running with its status. Plugins not read yet add nothing, so the run
 *  configurations are offered as soon as they arrive. */
export function checkChoicesOf(configs: { id: string; name: string }[], plugins: CheckPluginRow[] | null, t: Translate): { id: string; name: string }[] {
  return [
    ...configs,
    ...(plugins ?? []).map((p) => ({
      id: `${PLUGIN_CHECK_PREFIX}${p.id}`,
      name: p.status === 'running' ? t('jobs.task.checkPlugin', { name: p.name }) : t('jobs.task.checkPluginStatus', { name: p.name, status: statusLabel(p.status, t) })
    }))
  ]
}

/** A Task's title as the app shows it (G7b): the lifecycle Task's is stored in one language (lifecycleTask.ts), so it
 *  is shown in the app's; any other Task's is the person's or the coordinator's own words. */
export const taskTitleOf = (task: { title: string; lifecycle?: unknown }, t: Translate): string =>
  task.lifecycle !== undefined ? t('jobs.lifecycle.title') : task.title

/** A timeline line's Task title as the app shows it (G7b final review I2): the Task's, translated when it is the
 *  lifecycle Task; the line's own when the Task is gone. */
export const eventTitleOf = (
  e: { taskId?: string; taskTitle?: string },
  tasks: readonly { id: string; title: string; lifecycle?: unknown }[],
  t: Translate
): string => {
  const task = tasks.find((x) => x.id === e.taskId)
  return task ? taskTitleOf(task, t) : (e.taskTitle ?? '')
}

/** nodeMetaOf 의 판정을 문장으로. 우선순위는 그쪽에 있다 — 여기는 kind 마다 문구 하나다. undefined 면 줄을 그리지 않는다 */
export function nodeMetaText(m: NodeMeta, t: Translate): string | undefined {
  switch (m.kind) {
    case 'gate':
      return m.question
    case 'stopped':
      return m.failed === null
        ? t('jobs.convergence.node.stopped')
        : m.unavailable
          ? t('jobs.convergence.node.stoppedUnavailable', { failed: m.failed })
          : t('jobs.convergence.node.stoppedWithCheck', { failed: m.failed })
    case 'repairing':
      // A repair is never for a check that could not be made (C9): that one is not named as failing
      return m.failed === null || m.unavailable
        ? t('jobs.convergence.node.repairingNoCheck', { repairs: m.repairs, max: m.max })
        : t('jobs.convergence.node.repairing', { repairs: m.repairs, max: m.max, failed: m.failed })
    case 'checking':
      return m.retrying === null ? t('jobs.convergence.node.checking') : t('jobs.convergence.node.rechecking', { name: m.retrying })
    case 'reviewing':
      return t('jobs.convergence.node.reviewing', { round: m.round, max: m.max })
    case 'ci-waiting':
      return m.pr !== undefined ? t('jobs.convergence.node.ciWaiting', { pr: m.pr }) : t('jobs.convergence.node.ciWaitingNoPr')
    case 'failed':
      return t(m.unavailable ? 'jobs.convergence.node.unavailable' : 'jobs.convergence.node.failed', { name: m.name })
    case 'provider':
      return m.provider
    case 'none':
      return undefined
    default: {
      // 반환형이 string | undefined 라 case 를 하나 빼먹어도 "값을 안 준다"는 undefined 로도
      // 읽혀 tsc 가 조용히 통과한다(noImplicitReturns 는 이 저장소 세 tsconfig 어디에도 없다) —
      // 이 default 가 그 구멍을 막는다. NodeMeta 에 여덟째 kind 가 생기고 위 case 들이 그걸
      // 못 따라가면 m 이 여기서 never 가 아니게 되어 아래 대입이 타입 에러가 난다. 지금 일곱
      // kind 모두 위에서 처리되므로 이 분기는 실행되지 않는다.
      const exhaustive: never = m
      return exhaustive
    }
  }
}
