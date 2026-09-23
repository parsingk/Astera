// 한 프로젝트의 실행 구성 — 그 프로젝트에 저장된 것과 빌드 파일이 심는 시드를 합친 목록.
//
// **main 이 아니라 core 에 있는 이유: 두 프로세스가 답한다.** 앱은 실행 메뉴와 코디네이터의
// `run-configs` 에 이것을 쓰고, 앱이 닫혀 있으면 Host 가 `run-configs list` 와 `tasks add --validate`
// 를 스스로 답한다(src/host/orchDeps.ts, CLI phase D). Host 는 main 을 가져오지 않는다. 함수가 하나라
// 두 목록이 어느 id 가 있는지를 두고 갈라질 수 없다.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { detectSeedConfigs, mergeConfigs, type RunConfig } from './config'

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
