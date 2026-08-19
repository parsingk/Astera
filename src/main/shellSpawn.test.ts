// 조립된 명령이 **셸을 지난 뒤** 어떤 argv 로 자식에게 도착하는지 보는 검사.
//
// build.test.ts 는 buildCommand 가 만든 *문자열*까지만 본다. 그 아래 층 — 명령줄이 만들어지고
// cmd.exe 가 그것을 다시 쪼개는 곳 — 을 보는 검사가 하나도 없었기 때문에, quoteArg 가 인용한
// 모든 값이 win32 에서 둘로 갈리는 결함이 열한 작업 동안 초록불 아래에서 살아남았다.
// 여기서 검사하는 명령은 손으로 적지 않고 buildCommand 에서 그대로 얻는다 — 실제로 실행되는
// 문자열이 아니면 이 층을 대표하지 못한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buildCommand, type RunContext } from '../core/run/build'
import { shellSpawn } from '../core/run/shell'
import { tempDir } from '../core/worktrees/testRepo'

const ctx: RunContext = {
  packageManager: 'npm',
  gradleRunner: 'gradle',
  mavenRunner: 'mvn',
  composeFile: null,
  platform: 'win32'
}
const base = { id: 'x', name: 'x' }

let dir = '' // 공백이 든 경로를 일부러 만들기 위한 임시 디렉터리
let script = '' // argv 를 그대로 찍는 스크립트. 이름에 공백이 있다
let spacedNodeExe = '' // 공백이 든 경로에 있는 진짜 node.exe (정션 경유)
let childEnv: NodeJS.ProcessEnv

beforeAll(async () => {
  if (process.platform !== 'win32') return // 아래 테스트는 전부 win32 전용이다
  dir = await tempDir('astera-shellspawn-')
  script = path.join(dir, 'show args.js')
  await fs.writeFile(script, 'for (const a of process.argv.slice(1)) console.log(`ARGV|${a}|`)\n', 'utf8')
  // 인터프리터 자리에는 **경로에 공백이 있는 진짜 실행 파일**이 필요하다. node 가 설치된 경로에
  // 공백이 있다는 보장은 없으므로(이 PC 는 C:\Program Files\nodejs 지만 CI 러너의 node 경로에는
  // 공백이 없다) 공백이 든 이름의 정션을 만들어 node 디렉터리를 가리킨다. 정션은 Windows 에서
  // 권한 상승 없이 만들 수 있고, fs.rm 은 정션을 따라 들어가지 않고 링크만 지운다(실측)
  const spacedNodeDir = path.join(dir, 'bin dir')
  await fs.symlink(path.dirname(process.execPath), spacedNodeDir, 'junction')
  spacedNodeExe = path.join(spacedNodeDir, 'node.exe')
  // docker 없이 dockerfile 구성을 검사하기 위한 스텁. 불릴 때마다 하위명령을 한 줄 찍으므로
  // && 의 양쪽이 모두 실행됐는지 출력으로 알 수 있다
  const stubDir = path.join(dir, 'stub')
  await fs.mkdir(stubDir)
  await fs.writeFile(path.join(stubDir, 'docker.cmd'), '@echo off\r\necho DOCKER %1\r\n', 'utf8')
  // node 와 docker 를 이름만으로 찾을 수 있게 한다 — 이 검사의 대상은 인용이지 PATH 가 아니다.
  // PATH 키의 실제 대소문자는 OS가 정한다(win32는 보통 Path). { ...process.env } 는 대소문자를
  // 구분하는 평범한 객체라 여기에 PATH 를 새로 얹으면 Path 와 PATH 가 **둘 다** 남고, 자식이 어느
  // 쪽을 보는지가 불확실해진다 — jdk.ts 의 withJavaHomeOnPath 가 존재하는 이유와 같은 문제다.
  // 그래서 기존 키를 대소문자 무시로 찾아 **그 키**를 덮어쓴다. 여기서 이게
  // 틀어지면 dockerfile 케이스가 stub 이 아니라 이 PC 에 설치된 진짜 docker 를 부르게 된다
  const env: NodeJS.ProcessEnv = { ...process.env }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  env[pathKey] = `${path.dirname(process.execPath)};${stubDir};${env[pathKey] ?? ''}`
  childEnv = env
})

afterAll(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true }) // 실행마다 임시 디렉터리가 쌓이지 않게
})

/** 조립된 명령을 shellSpawn 이 정한 그대로 실제 셸에 통과시킨다.
 *
 *  windowsVerbatimArguments 는 명령줄을 `cmd.exe <args>` 로 그대로 만드는데, 이것이 **node-pty 가
 *  args 를 문자열로 받았을 때 만드는 명령줄과 정확히 같다** — argsToCommandLine
 *  (node_modules/node-pty/src/windowsPtyAgent.ts:255) 의 문자열 분기가 돌려주는 것은
 *  `${argsToCommandLine(file, [])} ${args}` 로, args 는 이스케이프 없이 그대로 들어가고 file 만
 *  인용 처리를 한 번 거친다. 여기서는 둘이 일치한다 — `cmd.exe` 에는 그 인용 처리가 반응하는 문자가
 *  없어(공백도 따옴표도 없다) 그대로 돌아오기 때문이다.
 *  이 동치가 이 파일이 실제 실행 경로를 대표한다는 근거다. */
function runThroughShell(command: string): { status: number | null; stdout: string; stderr: string } {
  const spawn = shellSpawn(command, 'win32')
  // 문자열이라는 것부터 못 박는다. 배열로 "정리"되면 node-pty 가 안쪽 따옴표를 \" 로 바꿔 값이
  // 쪼개지는데, 그때는 위의 동치가 깨져 아래 단언들이 실제 경로를 더 이상 대표하지 못한다
  expect(typeof spawn.args).toBe('string')
  const r = spawnSync(spawn.file, [spawn.args as string], {
    windowsVerbatimArguments: true,
    encoding: 'utf8',
    windowsHide: true,
    cwd: dir,
    env: childEnv
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 자식이 찍은 argv 를 순서대로 뽑는다 */
const argvOf = (stdout: string): string[] => [...stdout.matchAll(/^ARGV\|(.*)\|$/gm)].map((m) => m[1])

describe('조립된 명령이 셸을 지나 자식의 argv 가 되기까지', () => {
  it.runIf(process.platform === 'win32')('node: 공백이 든 파일 경로가 하나로 도착한다', () => {
    const command = buildCommand({ ...base, type: 'node', file: script }, ctx)
    expect(command).toBe(`node "${script}"`)
    const r = runThroughShell(command)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    // 쪼개졌다면 node 는 "…\show" 를 못 찾고 죽는다. 하나로 도착했을 때만 이 단언이 선다
    expect(argvOf(r.stdout)).toEqual([script])
  })

  it.runIf(process.platform === 'win32')('python: 따옴표로 시작하는 명령도 실행되고 파일 인수가 온전하다', () => {
    // 인터프리터 경로에 공백이 있으면 명령 자체가 따옴표로 시작한다 — /s 가 없으면 cmd 가 여기서
    // 'C:\Program' 을 실행하려 든다. (파이썬 설치에 기대지 않으려고 인터프리터 자리에 node.exe 를
    // 두었다. 여기서 검사하는 것은 인터프리터의 정체가 아니라 명령의 모양이다)
    const command = buildCommand({ ...base, type: 'python', file: script, interpreter: spacedNodeExe }, ctx)
    expect(command.startsWith('"')).toBe(true)
    const r = runThroughShell(command)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(argvOf(r.stdout)).toEqual([script])
  })

  it.runIf(process.platform === 'win32')('dockerfile: && 로 이은 두 명령이 모두 실행된다', () => {
    const command = buildCommand({ ...base, type: 'dockerfile', imageTag: 'astera:dev' }, ctx)
    const r = runThroughShell(command)
    expect(r.status).toBe(0)
    // /s /c "…" 의 바깥 따옴표 안에서도 cmd 가 && 를 구분자로 읽는다는 뜻이다
    expect(r.stdout).toContain('DOCKER build')
    expect(r.stdout).toContain('DOCKER run')
  })
})
