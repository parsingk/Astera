import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  installStub,
  legacyStubPaths,
  stubTargetPath,
  LEGACY_STUB_MARKER,
  STUB_MARKER
} from './stub'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-orchstub-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** 앱이 소유한 stub 원본을 흉내낸다 — 표시가 없으면 installStub이 아무것도 하지 않는다.
 *
 *  마커를 **여러 줄 주석 + 뒤 빈 줄**로 쓰는 이유: 실제 `resources/skills/orchestration-stub.md`가
 *  그 형태이고, 단일 줄로 흉내내면 리뷰가 지적한 함정(줄 단위 필터가 둘째 줄과 빈 줄을 남겨 비교가
 *  영구히 실패한다)을 픽스처가 가려 버린다. */
const writeSource = async (body = '# stub\n'): Promise<string> => {
  const p = path.join(dir, 'orchestration-stub.md')
  await fs.writeFile(p, `---\nname: x\n---\n\n${markerBlock()}\n${body}`, 'utf8')
  return p
}

/** 실제 리소스와 같은 2줄 HTML 주석 */
const markerBlock = (): string => `<!-- ${STUB_MARKER} — 앱이 이 파일을 소유한다. 직접 고치면\n     덮어써진다. 이 표시를 지우면 앱이 남의 것으로 본다. -->`

/** 마커 도입 전 빌드가 쓴 파일을 만든다.
 *  **구현과 다른 방법으로** 만들어야 순환 테스트가 되지 않는다 — 구현은 정규식으로 주석 span을
 *  지우고, 여기서는 인덱스로 잘라낸다. 픽스처가 구현과 같은 로직이면 `f(x) === f(x)`를 확인하는
 *  것과 다를 바 없다(리뷰가 정확히 그 함정을 지적했다). */
const stripMarkerByIndex = (s: string): string => {
  const start = s.indexOf('<!--')
  const end = s.indexOf('-->', start)
  if (start < 0 || end < 0) return s
  // 주석과 그 뒤 줄바꿈들을 걷어낸다. `\r`도 함께 봐야 한다 — 이 리소스는 main에서 CRLF로
  // 체크아웃된다(core.autocrlf=true). `/^\n+/`만 쓰면 `\r`에 막혀 빈 줄이 남고, 그러면
  // 픽스처가 프로덕션과 어긋나 실제 결함이 없는데도 이 테스트가 깨진다(병합 중 실제 발생).
  return s.slice(0, start) + s.slice(end + 3).replace(/^[\r\n]+/, '')
}

describe('installStub', () => {
  it('계정 configDir 아래 skills/astera-orchestration/SKILL.md에 쓴다', async () => {
    // .claude를 하드코딩하지 않는다 — 계정별 CLAUDE_CONFIG_DIR·CODEX_HOME 격리가 이 앱의 존재 이유다.
    // 디렉토리 이름에 앱 이름을 넣는다 — 사용자 공용 config 디렉토리라 일반명은 다른 도구와 충돌한다.
    const stubPath = await writeSource()
    const configDir = path.join(dir, 'accounts', 'work')
    const r = await installStub({ stubPath, configDirs: [configDir] })
    const target = stubTargetPath(configDir)
    expect(r.written).toEqual([target])
    expect(target).toBe(path.join(configDir, 'skills', 'astera-orchestration', 'SKILL.md'))
    expect(await fs.readFile(target, 'utf8')).toContain('# stub')
  })

  it('여러 계정에 각각 쓴다 (claude·codex 경로가 같다)', async () => {
    const stubPath = await writeSource()
    const dirs = [path.join(dir, '.claude-accounts', 'a'), path.join(dir, '.codex-accounts', 'b')]
    const r = await installStub({ stubPath, configDirs: dirs })
    expect(r.written).toHaveLength(2)
    for (const d of dirs) {
      expect(await fs.readFile(stubTargetPath(d), 'utf8')).toContain(STUB_MARKER)
    }
  })

  // 마커가 있으면 **내용과 무관하게** 갱신한다 — 소유 판정을 넓힐 때 이 경로가 그대로
  // 남아야 한다(마커 판정이 내용 비교에 종속되면 버전이 오른 stub이 갱신되지 않는다)
  it('버전이 올라간 stub은 덮어쓴다 — 앱이 쓴 파일이면', async () => {
    const configDir = path.join(dir, 'work')
    await fs.mkdir(path.dirname(stubTargetPath(configDir)), { recursive: true })
    await fs.writeFile(stubTargetPath(configDir), `<!-- ${STUB_MARKER} -->\n# old\n`, 'utf8')
    const r = await installStub({ stubPath: await writeSource('# new\n'), configDirs: [configDir] })
    expect(r.written).toHaveLength(1)
    expect(await fs.readFile(stubTargetPath(configDir), 'utf8')).toContain('# new')
  })

  // 리뷰 지적: 기본 계정의 configDir은 실제 ~/.claude다 — 이 경계가 없으면 사용자가 직접 쓴
  // 동명 스킬을 조용히 지운다(실제로 검증 중에 홈에 파일이 떨어졌다).
  it('소유 표시가 없는 기존 파일은 건드리지 않는다 — 사용자 스킬을 덮지 않는다', async () => {
    const configDir = path.join(dir, 'work')
    const target = stubTargetPath(configDir)
    const mine = '---\nname: astera-orchestration\n---\n# 사용자가 직접 쓴 스킬\n'
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, mine, 'utf8')
    const logs: string[] = []
    const r = await installStub({
      stubPath: await writeSource(),
      configDirs: [configDir],
      log: (m) => logs.push(m)
    })
    expect(r.skipped).toEqual([target])
    expect(r.written).toEqual([])
    expect(await fs.readFile(target, 'utf8')).toBe(mine) // 한 글자도 바뀌지 않았다
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(target)
  })

  // 마커 유무 **하나만** 보면 앱이 자기가 쓴 파일을 남의 것으로 잠근다 — 마커 기능 이전
  // 빌드가 쓴 stub 3개가 실기기에서 그렇게 영구히 건너뛰어졌다(orchestration.log 관측).
  it('소유 표시가 없어도 마커 줄만 빼고 현재 stub과 같으면 앱 소유로 보고 갱신한다', async () => {
    const stubPath = await writeSource('# stub v2\n')
    const content = await fs.readFile(stubPath, 'utf8')
    // 마커 도입 전 빌드가 쓴 파일 = 지금 stub에서 마커 주석 블록만 없는 파일.
    // 구현과 다른 방법(인덱스 절단)으로 만든다 — 순환 방지, 위 헬퍼 주석 참조
    const preMarker = stripMarkerByIndex(content)
    expect(preMarker).not.toContain(STUB_MARKER)
    // 마커의 둘째 줄도 남아 있지 않아야 한다 — C1이 정확히 그 잔여로 실패했다
    expect(preMarker).not.toContain('덮어써진다')
    const configDir = path.join(dir, 'work')
    const target = stubTargetPath(configDir)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, preMarker, 'utf8')
    const logs: string[] = []
    const r = await installStub({ stubPath, configDirs: [configDir], log: (m) => logs.push(m) })
    expect(r.skipped).toEqual([])
    expect(r.written).toEqual([target])
    expect(await fs.readFile(target, 'utf8')).toBe(content) // 마커까지 회복됐다
    expect(logs).toEqual([])
  })

  // 리뷰 지적: 위 테스트는 픽스처를 쓴다. 실제로 배포되는 파일의 마커 구조가 바뀌면(주석이
  // 3줄이 되거나 형태가 달라지면) 픽스처는 통과하는데 실기기는 다시 잠긴다. 그래서 **배포되는
  // 그 파일 자체**로 한 번 더 확인한다 — 이 테스트가 구조 드리프트를 원천 차단한다.
  it('실제 리소스 stub도 마커를 뺀 옛 파일을 앱 소유로 인식한다', async () => {
    const real = path.join(__dirname, '../../../resources/skills/orchestration-stub.md')
    const content = await fs.readFile(real, 'utf8')
    expect(content).toContain(STUB_MARKER) // 전제: 배포 파일에 표시가 있다
    const preMarker = stripMarkerByIndex(content)
    expect(preMarker).not.toContain(STUB_MARKER)
    const configDir = path.join(dir, 'real')
    const target = stubTargetPath(configDir)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, preMarker, 'utf8')
    const logs: string[] = []
    const r = await installStub({ stubPath: real, configDirs: [configDir], log: (m) => logs.push(m) })
    expect(r.skipped).toEqual([]) // 건너뛰면 C1이 되살아난 것이다
    expect(r.written).toEqual([target])
    expect(logs).toEqual([])
  })

  it('건너뜀 로그가 단정하지 않는다 — 아는 것은 "표시가 없고 현재 stub과 다르다"뿐이다', async () => {
    // 옛 버전 앱이 쓴 stub도 이 분기로 온다(비교 대상은 현재 리소스의 stub 하나뿐이다).
    // 그것을 "앱이 만들지 않은 파일"이라고 단정하면 로그가 사실보다 많이 말한다.
    const configDir = path.join(dir, 'work')
    const target = stubTargetPath(configDir)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '# 표시도 없고 내용도 다르다\n', 'utf8')
    const logs: string[] = []
    const stubPath = await writeSource()
    await installStub({ stubPath, configDirs: [configDir], log: (m) => logs.push(m) })
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain('the app did not create')
    expect(logs[0]).toContain('no ownership marker')
    expect(logs[0]).toContain('current stub')
    expect(logs[0]).toContain(target) // 사용자가 판단할 근거
  })

  it('원본에 소유 표시가 없으면 아무것도 설치하지 않는다', async () => {
    // 이 방어가 없으면 우리가 쓴 파일이 다음 기동에 남의 것으로 보여 갱신이 영구히 멈춘다
    const stubPath = path.join(dir, 'no-marker.md')
    await fs.writeFile(stubPath, '# stub without marker\n', 'utf8')
    const configDir = path.join(dir, 'work')
    const logs: string[] = []
    const r = await installStub({ stubPath, configDirs: [configDir], log: (m) => logs.push(m) })
    expect(r).toEqual({ written: [], unchanged: [], skipped: [], failed: [], removed: [] })
    expect(logs).toHaveLength(1)
    await expect(fs.stat(stubTargetPath(configDir))).rejects.toThrow()
  })

  it('내용이 같으면 다시 쓰지 않는다 — 파일 워쳐를 깨우지 않는다', async () => {
    const stubPath = await writeSource()
    const configDir = path.join(dir, 'work')
    await installStub({ stubPath, configDirs: [configDir] })
    const target = stubTargetPath(configDir)
    const before = (await fs.stat(target)).mtimeMs
    const r = await installStub({ stubPath, configDirs: [configDir] })
    expect(r.written).toEqual([])
    expect(r.unchanged).toEqual([target])
    expect((await fs.stat(target)).mtimeMs).toBe(before)
  })

  it('한 계정이 실패해도 던지지 않고 나머지는 설치한다 — 기동을 막지 않는다', async () => {
    const stubPath = await writeSource()
    // 디렉토리가 될 자리에 파일을 놓아 mkdir을 실패시킨다
    const bad = path.join(dir, 'bad')
    await fs.mkdir(bad, { recursive: true })
    await fs.writeFile(path.join(bad, 'skills'), 'not a directory', 'utf8')
    const good = path.join(dir, 'good')
    const logs: string[] = []
    const r = await installStub({ stubPath, configDirs: [bad, good], log: (m) => logs.push(m) })
    expect(r.failed).toEqual([stubTargetPath(bad)])
    expect(r.written).toEqual([stubTargetPath(good)])
    expect(logs).toHaveLength(1)
  })

  it('원본이 없으면 로그만 남기고 아무것도 하지 않는다', async () => {
    const logs: string[] = []
    const configDir = path.join(dir, 'work')
    const r = await installStub({
      stubPath: path.join(dir, 'missing.md'),
      configDirs: [configDir],
      log: (m) => logs.push(m)
    })
    expect(r).toEqual({ written: [], unchanged: [], skipped: [], failed: [], removed: [] })
    expect(logs).toHaveLength(1)
    await expect(fs.stat(stubTargetPath(configDir))).rejects.toThrow()
  })

  it('계정이 없으면 아무 일도 없다', async () => {
    const r = await installStub({ stubPath: await writeSource(), configDirs: [] })
    expect(r).toEqual({ written: [], unchanged: [], skipped: [], failed: [], removed: [] })
  })

  it('배포되는 실제 stub 원본에 소유 표시가 있다', async () => {
    // 이 단정이 없으면 resources의 원본에서 표시가 사라져도 테스트가 통과하고, 설치가 조용히
    // 멈춘다(위 "원본에 소유 표시가 없으면" 분기로 빠진다)
    const real = path.join(process.cwd(), 'resources', 'skills', 'orchestration-stub.md')
    expect(await fs.readFile(real, 'utf8')).toContain(STUB_MARKER)
  })
})

describe('구 경로 정리', () => {
  /** 리브랜딩 전 앱이 쓴 stub. 마커 문구가 지금과 다르다 — 그때는 앱 이름이 claude-manager 였다. */
  const writeLegacy = async (configDir: string, marker: string): Promise<string> => {
    const p = legacyStubPaths(configDir)[0]
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, `---\nname: orchestration\n---\n\n<!-- ${marker} — 앱이 소유한다. -->\n\n# 구 stub\n`, 'utf8')
    return p
  }

  it('구 경로는 skills/orchestration/SKILL.md 다', () => {
    // 이 이름이 곧 CM_ORCH_CLI 시절의 스킬이다. 개명(astera-orchestration) 전 경로가 남으면
    // 두 스킬이 같은 description 으로 동시에 로드되고, 에이전트가 낡은 쪽을 잡으면 존재하지
    // 않는 환경변수를 확인하고 "orchestration 이 꺼져 있다"고 오진한다 — 실기기에서 관측.
    expect(legacyStubPaths('C:/cfg')).toEqual([path.join('C:/cfg', 'skills', 'orchestration', 'SKILL.md')])
  })

  it('앱이 쓴 구 stub 을 지우고, 비게 된 디렉토리도 걷어낸다', async () => {
    const configDir = path.join(dir, 'work')
    const legacy = await writeLegacy(configDir, STUB_MARKER)
    const r = await installStub({ stubPath: await writeSource(), configDirs: [configDir] })
    expect(r.removed).toEqual([legacy])
    await expect(fs.stat(legacy)).rejects.toThrow()
    await expect(fs.stat(path.dirname(legacy))).rejects.toThrow() // 빈 디렉토리도 남기지 않는다
    expect(await fs.readFile(stubTargetPath(configDir), 'utf8')).toContain('# stub') // 새 경로는 정상 설치
  })

  it('리브랜딩 전 마커도 앱 소유로 인정한다', async () => {
    // 현재 마커(STUB_MARKER)만 보면 정리 대상이 하나도 안 잡힌다 — 실기기의 7개가 모두
    // `managed by claude-manager (SERVER-3004)` 문구를 달고 있다.
    const configDir = path.join(dir, 'work')
    const legacy = await writeLegacy(configDir, `${LEGACY_STUB_MARKER} (SERVER-3004)`)
    const r = await installStub({ stubPath: await writeSource(), configDirs: [configDir] })
    expect(r.removed).toEqual([legacy])
    await expect(fs.stat(legacy)).rejects.toThrow()
  })

  it('소유 표시가 없는 구 경로 파일은 남긴다 — 사용자 스킬을 지우지 않는다', async () => {
    // 새 경로의 판정과 같은 경계다. 기본 계정의 configDir 은 실제 ~/.claude 이고, 사용자가
    // `orchestration` 이라는 스킬을 직접 만들어 뒀을 수 있다.
    const configDir = path.join(dir, 'work')
    const legacy = legacyStubPaths(configDir)[0]
    const mine = '---\nname: orchestration\n---\n# 사용자가 직접 쓴 스킬\n'
    await fs.mkdir(path.dirname(legacy), { recursive: true })
    await fs.writeFile(legacy, mine, 'utf8')
    const logs: string[] = []
    const r = await installStub({
      stubPath: await writeSource(),
      configDirs: [configDir],
      log: (m) => logs.push(m)
    })
    expect(r.removed).toEqual([])
    expect(await fs.readFile(legacy, 'utf8')).toBe(mine) // 한 글자도 바뀌지 않았다
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(legacy) // 사용자가 판단할 근거
  })

  it('구 디렉토리에 다른 파일이 남아 있으면 디렉토리는 남긴다', async () => {
    const configDir = path.join(dir, 'work')
    const legacy = await writeLegacy(configDir, STUB_MARKER)
    const sibling = path.join(path.dirname(legacy), 'NOTES.md')
    await fs.writeFile(sibling, '사용자 메모', 'utf8')
    const r = await installStub({ stubPath: await writeSource(), configDirs: [configDir] })
    expect(r.removed).toEqual([legacy])
    expect(await fs.readFile(sibling, 'utf8')).toBe('사용자 메모') // 남의 파일은 그대로
  })

  it('새 경로 설치가 실패하면 구 경로를 지우지 않는다 — 스킬이 0개인 상태를 만들지 않는다', async () => {
    const configDir = path.join(dir, 'work')
    const legacy = await writeLegacy(configDir, STUB_MARKER)
    // 타겟 자리를 디렉토리로 막아 writeFile 을 실패시킨다
    await fs.mkdir(stubTargetPath(configDir), { recursive: true })
    const r = await installStub({ stubPath: await writeSource(), configDirs: [configDir] })
    expect(r.failed).toEqual([stubTargetPath(configDir)])
    expect(r.removed).toEqual([])
    await expect(fs.stat(legacy)).resolves.toBeTruthy() // 낡았어도 없는 것보다는 낫다
  })

  it('새 경로가 이미 최신이어도 구 경로는 정리한다', async () => {
    // 두 번째 기동 경로다. unchanged 로 빠지면서 정리를 건너뛰면 유령 스킬이 영구히 남는다.
    const stubPath = await writeSource()
    const configDir = path.join(dir, 'work')
    await installStub({ stubPath, configDirs: [configDir] })
    const legacy = await writeLegacy(configDir, STUB_MARKER)
    const r = await installStub({ stubPath, configDirs: [configDir] })
    expect(r.unchanged).toEqual([stubTargetPath(configDir)])
    expect(r.removed).toEqual([legacy])
  })

  it('구 경로가 없으면 아무 일도 없다', async () => {
    const configDir = path.join(dir, 'work')
    const r = await installStub({ stubPath: await writeSource(), configDirs: [configDir] })
    expect(r.removed).toEqual([])
  })

  it('원본에 소유 표시가 없으면 정리도 하지 않는다', async () => {
    // 원본이 깨진 상태에서는 아무것도 쓰지 않는다는 기존 규칙과 같은 이유다 — 그 상태에서
    // 파일을 지우는 것은 더 나쁘다.
    const configDir = path.join(dir, 'work')
    const legacy = await writeLegacy(configDir, STUB_MARKER)
    const stubPath = path.join(dir, 'no-marker.md')
    await fs.writeFile(stubPath, '# stub without marker\n', 'utf8')
    const r = await installStub({ stubPath, configDirs: [configDir] })
    expect(r.removed).toEqual([])
    await expect(fs.stat(legacy)).resolves.toBeTruthy()
  })
})
