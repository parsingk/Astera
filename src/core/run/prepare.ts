// run.start 와 run.list 가 공유하던 조립 과정. ipc.ts 안에 있을 때는 테스트도 다른 main 코드도
// 닿을 수 없었다 — 그 파일은 첫 줄에서 electron 을 import 하고 registerIpc 하나만 export 한다.
// 검증(TaskValidator)이 같은 조립을 필요로 하므로, 복제 대신 여기로 들어냈다.
//
// 구성 목록(loadRunConfigs)은 core/run/load.ts 로 더 내려갔다 — 앱이 닫혀 있을 때 Host 가 같은 목록을
// 답하고(CLI phase D), Host 는 main 을 가져오지 않는다. 여기서 다시 내보내 부르는 쪽은 그대로다.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RunConfig } from './config'
import { loadRunConfigs } from './load'
import { buildCommand, buildRunContext } from './build'
import { missingRequiredFields } from './migrate'
import { isPathWithin } from '../files/tree'
import { planLaunch, type LaunchPlan } from './launch'
import type { RunnableConfig } from './types'

export { loadRunConfigs, readSeedTexts, type SeedTexts } from './load'

export interface PrepareRunArgs {
  /** 구성을 찾을 프로젝트 */
  projectPath: string
  configId: string
  /** RunConfigStore 가 가진 그 프로젝트의 구성들 */
  stored: RunConfig[]
  /** 구성에 박힌 cwd 를 버린다. 검증에서 true — 워커가 일한 트리가 아닌 곳을 가리키기 때문이다 */
  ignoreConfigCwd?: boolean
  assertAllowedPath: (p: string) => Promise<string>
  t: (key: string, params?: Record<string, string | number>) => string
}

/** 구성 하나를 실행 가능한 명령으로 만든다. 실패는 throw — 호출자(IPC 핸들러, 검증기)가 각자
 *  다루기 때문에 여기서 형태를 정하지 않는다. */
export async function prepareRun(
  a: PrepareRunArgs
): Promise<{ config: RunConfig; command: string; projectName: string }> {
  const { configs, files } = await loadRunConfigs({
    projectPath: a.projectPath,
    stored: a.stored,
    assertAllowedPath: a.assertAllowedPath
  })
  const config = configs.find((c) => c.id === a.configId)
  if (!config) throw new Error(`NO_CONFIG: ${a.configId}`)
  // 미완성 구성을 저장하는 것은 허용되지만 실행은 아니다. 비어 있는 필드를 이름으로 알려 준다 —
  // 그냥 조립하면 빈 인자가 명령에 끼어들어 도구 안쪽에서 실패하고, 그 메시지는 사용자가 채워야
  // 할 필드와 아무 관계가 없다.
  const missing = missingRequiredFields(config)
  if (missing.length > 0)
    throw new Error(a.t('run.start.incomplete', { fields: missing.map((k) => a.t(`run.field.${k}`)).join(', ') }))
  // A compound has no command to assemble. Validation's contract is a single command and a single
  // exit code; chaining is run.start's job, through prepareLaunch.
  if (config.type === 'compound') throw new Error(a.t('run.start.compoundNotRunnable'))
  const cwd = a.ignoreConfigCwd ? undefined : await resolveRunCwd(a, config.cwd)
  return {
    config: { ...config, cwd },
    // run.list 의 미리보기와 실제 실행이 어긋나지 않도록 buildRunContext 는 한 곳에서만 만든다.
    //
    // **검증에서는 조립 컨텍스트와 실행 위치가 다른 트리에서 온다.** files 는 projectPath(=Run.cwd)
    // 의 목록이지만, 검증 명령은 Dispatch.cwd 에서 돈다(ignoreConfigCwd: true) — ./gradlew·./mvnw
    // 존재 여부, composeFile 이름, 패키지 매니저 선택이 실행되지 않는 트리에서 결정된다.
    // git 워크트리라면 추적 파일이 같으므로 무해하지만, 래퍼나 lockfile 이 추적되지 않으면
    // 조립이 틀리고 그것이 0 이 아닌 종료 코드로 나타나 작업 탓이 된다. 고치려면 컨텍스트를
    // 실행 트리에서 읽어야 하는데, 그러면 구성 조회와 컨텍스트 계산의 기준이 갈라진다 —
    // ADR-003 이 기록한 "구성 소유가 저장소를 따라야 하는지 워크트리를 따라야 하는지"와 같은 판단.
    command: buildCommand(config, buildRunContext(files, process.platform)),
    projectName: path.basename(a.projectPath) || a.projectPath
  }
}

export interface PreparedStep {
  config: RunnableConfig
  command: string
}

/** Everything run.start needs before it starts anything: the plan, and every configuration in it
 *  assembled.
 *
 *  **loadRunConfigs runs once.** A readdir and three build-file reads per step would be paid for
 *  nothing — every step shares one project and therefore one RunContext.
 *
 *  **Nothing is started here, and every failure is thrown before anything could be.** A required field
 *  left empty three steps down fails the whole ▶, rather than after two runs have already gone. */
export async function prepareLaunch(a: {
  projectPath: string
  rootId: string
  stored: RunConfig[]
  assertAllowedPath: (p: string) => Promise<string>
  t: (key: string, params?: Record<string, string | number>) => string
}): Promise<{
  plan: Extract<LaunchPlan, { ok: true }>
  prepared: Map<string, PreparedStep>
  projectName: string
}> {
  const { configs, files } = await loadRunConfigs({
    projectPath: a.projectPath,
    stored: a.stored,
    assertAllowedPath: a.assertAllowedPath
  })
  const plan = planLaunch(configs, a.rootId)
  if (!plan.ok) throw planError(plan, configs, a.t)

  const incomplete = (c: RunConfig): Error | null => {
    const missing = missingRequiredFields(c)
    return missing.length === 0
      ? null
      : new Error(a.t('run.start.incomplete', { fields: missing.map((k) => a.t(`run.field.${k}`)).join(', ') }))
  }

  // **The root is checked even though it may not be a step.** A compound expands into its members and
  // contributes no step of its own, so a compound with an empty member list would otherwise plan to
  // nothing at all and reach the executor as a launch with no runs in it. planLaunch already proved
  // the root resolves.
  const rootBad = incomplete(configs.find((c) => c.id === a.rootId) as RunConfig)
  if (rootBad) throw rootBad
  // The same hole one level down: every member being an empty compound leaves no steps either. Rare
  // enough not to name each offender, but it must not reach the executor.
  if (plan.steps.length === 0)
    throw new Error(a.t('run.start.incomplete', { fields: a.t('run.field.members') }))

  const ctx = buildRunContext(files, process.platform)
  const prepared = new Map<string, PreparedStep>()
  for (const step of plan.steps) {
    // planLaunch already proved every step resolves, so this lookup cannot miss.
    const config = configs.find((c) => c.id === step.configId) as RunConfig
    const bad = incomplete(config)
    if (bad) throw bad
    // A compound is never a step — planLaunch expands it away — so this narrowing always holds; it is
    // stated rather than cast so a future change to the planner fails here instead of silently.
    if (config.type === 'compound') throw new Error(a.t('run.start.compoundNotRunnable'))
    const cwd = await resolveRunCwd(a, config.cwd)
    const withCwd = { ...config, cwd }
    prepared.set(step.configId, { config: withCwd, command: buildCommand(withCwd, ctx) })
  }
  return { plan, prepared, projectName: path.basename(a.projectPath) || a.projectPath }
}

/** A plan failure as a thrown, translated error, so run.start's existing rejection path carries it to
 *  the renderer's existing toast. Ids are mapped to names here — an id is not something a message can
 *  show a user. */
function planError(
  plan: Extract<LaunchPlan, { ok: false }>,
  configs: RunConfig[],
  t: (key: string, params?: Record<string, string | number>) => string
): Error {
  const nameOf = (id: string): string => configs.find((c) => c.id === id)?.name ?? id
  if (plan.reason === 'CYCLE') return new Error(t('run.start.cycle', { path: plan.path.map(nameOf).join(' → ') }))
  // A missing root is what prepareRun has always reported as NO_CONFIG; only a broken reference is new.
  if (plan.heldBy === null) return new Error(`NO_CONFIG: ${plan.id}`)
  return new Error(t('run.start.missingTask', { name: nameOf(plan.heldBy) }))
}

/** Validates a run configuration's cwd and returns the absolute path that will **actually be used**.
 *  cwd comes from two places outside the trust boundary — the stored file (hand-editable on disk) and
 *  the run.saveConfigs IPC (the renderer, checked again there since a hand-edited file bypasses that
 *  check) — and runManager passes it straight through as the PTY's cwd, so without validation a
 *  process starts outside the allowed roots.
 *  A relative path is resolved against the project root; resolving against this process's own cwd
 *  instead would run somewhere other than intended.
 *  **The return value is what must be handed to execution** — validating and then passing the original
 *  cwd puts this in the "validated one value, used another" category, and a defect of that shape has
 *  recurred six times in this feature area. */
async function resolveRunCwd(
  a: { projectPath: string; assertAllowedPath: (p: string) => Promise<string>; t: PrepareRunArgs['t'] },
  cwd: unknown
): Promise<string | undefined> {
  if (cwd === undefined || cwd === null || cwd === '') return undefined
  if (typeof cwd !== 'string') throw new Error(a.t('run.config.cwdNotString'))
  const resolved = path.resolve(a.projectPath, cwd)
  await a.assertAllowedPath(resolved)
  if (!isPathWithin(a.projectPath, resolved)) throw new Error(a.t('run.config.cwdOutsideProject'))
  return resolved
}
