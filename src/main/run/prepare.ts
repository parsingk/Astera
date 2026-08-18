// run.start 와 run.list 가 공유하던 조립 과정. ipc.ts 안에 있을 때는 테스트도 다른 main 코드도
// 닿을 수 없었다 — 그 파일은 첫 줄에서 electron 을 import 하고 registerIpc 하나만 export 한다.
// 검증(TaskValidator)이 같은 조립을 필요로 하므로, 복제 대신 여기로 들어냈다.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { detectSeedConfigs, mergeConfigs, type RunConfig } from '../../core/run/config'
import { buildCommand, buildRunContext } from '../../core/run/build'
import { missingRequiredFields } from '../../core/run/migrate'
import { isPathWithin } from '../../core/files/tree'

export interface SeedTexts {
  packageJson: string | null
  buildGradle: string | null
  pom: string | null
}

/** 시드 판정에 필요한 빌드 파일 본문을 읽는다. .kts 와 .gradle 이 둘 다 있으면 .kts 가 이긴다.
 *  읽기 실패는 null 로 삼킨다 — 파일 하나를 못 읽었다고 run.list 와 run.start 전체가 무너지면 안 된다. */
export async function readSeedTexts(projectRoot: string, files: string[]): Promise<SeedTexts> {
  const readIfPresent = async (name: string): Promise<string | null> => {
    if (!files.includes(name)) return null
    try {
      return await fs.readFile(path.join(projectRoot, name), 'utf8')
    } catch {
      return null
    }
  }
  const gradleFile = files.includes('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle'
  const [packageJson, buildGradle, pom] = await Promise.all([
    readIfPresent('package.json'),
    readIfPresent(gradleFile),
    readIfPresent('pom.xml')
  ])
  return { packageJson, buildGradle, pom }
}

/** 저장된 구성과 자동 감지된 시드를 합친 목록. 파일 목록과 본문도 함께 돌려준다 —
 *  호출자가 buildRunContext 나 isSpringBootProject 같은 판정에 다시 필요로 한다.
 *
 *  **assertAllowedPath 가 필수 인자인 이유:** 이 함수는 projectPath 를 readdir 하고 그 아래
 *  빌드 파일들을 읽는다. IPC 핸들러(run.list)는 자기 자리에서 이미 검사하지만, 오케스트레이션의
 *  run-configs 는 코디네이터가 준 Run.cwd 를 그대로 들고 들어온다 — resolveProjectRoot 는
 *  ADR-003 이 명시하듯 "최선 노력이지 검증이 아니다". 인자로 받아 두면 호출자가 검사를 빠뜨릴
 *  자리가 없다. 앱의 다른 모든 경로 읽기가 이 가드 뒤에 있다. */
export async function loadRunConfigs(a: {
  projectPath: string
  stored: RunConfig[]
  assertAllowedPath: (p: string) => Promise<string>
}): Promise<{ configs: RunConfig[]; files: string[]; texts: SeedTexts }> {
  await a.assertAllowedPath(a.projectPath)
  let files: string[] = []
  try {
    files = (await fs.readdir(a.projectPath, { withFileTypes: true })).map((d) => d.name)
  } catch {
    /* 읽을 수 없으면 빈 목록 — 저장된 구성만 남는다 */
  }
  const texts = await readSeedTexts(a.projectPath, files)
  return { configs: mergeConfigs(detectSeedConfigs(files, texts), a.stored), files, texts }
}

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
  const cwd = a.ignoreConfigCwd ? undefined : await resolveRunCwd(a, config.cwd)
  return {
    config: { ...config, cwd },
    // run.list 의 미리보기와 실제 실행이 어긋나지 않도록 buildRunContext 는 한 곳에서만 만든다
    command: buildCommand(config, buildRunContext(files, process.platform)),
    projectName: path.basename(a.projectPath) || a.projectPath
  }
}

/** Validates a run configuration's cwd and returns the absolute path that will **actually be used**.
 *  cwd comes from two places outside the trust boundary — the stored file (hand-editable on disk) and
 *  the run.saveConfig IPC (the renderer, checked again there since a hand-edited file bypasses that
 *  check) — and runManager passes it straight through as the PTY's cwd, so without validation a
 *  process starts outside the allowed roots.
 *  A relative path is resolved against the project root; resolving against this process's own cwd
 *  instead would run somewhere other than intended.
 *  **The return value is what must be handed to execution** — validating and then passing the original
 *  cwd puts this in the "validated one value, used another" category, and a defect of that shape has
 *  recurred six times in this feature area. */
async function resolveRunCwd(a: PrepareRunArgs, cwd: unknown): Promise<string | undefined> {
  if (cwd === undefined || cwd === null || cwd === '') return undefined
  if (typeof cwd !== 'string') throw new Error(a.t('run.config.cwdNotString'))
  const resolved = path.resolve(a.projectPath, cwd)
  await a.assertAllowedPath(resolved)
  if (!isPathWithin(a.projectPath, resolved)) throw new Error(a.t('run.config.cwdOutsideProject'))
  return resolved
}
