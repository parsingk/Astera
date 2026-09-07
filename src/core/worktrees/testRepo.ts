import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 임시 디렉터리를 만들고 **정규 경로로** 돌려준다.
 *
 *  os.tmpdir()이 이미 정규 경로라는 가정이 CI에서 깨진다. Windows 러너의 임시 경로에는 8.3 단축
 *  이름이 들어 있고(`RUNNER~1`), macOS의 `/var/folders/…`는 `/private/var/…`로 가는 심볼릭
 *  링크다. git은 어느 쪽이든 **긴 실제 경로**를 보고하는데, 이 코드베이스의 경로 비교는
 *  path.resolve만 쓴다 — `..`은 풀지만 단축 이름도 링크도 풀지 않는다. 그래서 등록된 워크트리를
 *  못 찾고 "git이 잊어버린 워크트리" 분기로 빠졌다.
 *
 *  개발 PC의 임시 경로에는 둘 다 없어서 로컬에서는 늘 통과했고, 스위트가 저장소에 공개되어 CI가
 *  실제로 돌리기 시작하고 나서야 드러났다. */
export async function tempDir(prefix: string): Promise<string> {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
}

/** git, synchronously, for fixtures — with git's stderr carried in the error, and one retry when the
 *  spawn itself was refused.
 *
 *  execFileSync's own Error says only "Command failed: git commit -m init", so a fixture that failed
 *  now and then left nothing to go on. The one such failure that was finally caught read exit -1
 *  with an empty stderr: git had never started. On Windows, under the parallel spawning a full test
 *  run produces, CreateProcess is refused for a moment (EPERM) and works right after — the adapter
 *  in git.ts handles the same thing for the app. Nothing ran, so one retry is safe for any command. */
const SPAWN_REFUSED = new Set(['EPERM', 'EBUSY'])
const RETRY_DELAY_MS = 50
type SpawnError = { code?: unknown; status?: number | null; stderr?: Buffer | string; stdout?: Buffer | string }
export function gitSync(cwd: string, args: string[]): string {
  const attempt = (): string =>
    execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe', encoding: 'utf8' }).trim()
  const txt = (v: Buffer | string | undefined): string => (v ? String(v).trim() : '')
  const describe = (e: SpawnError): Error =>
    new Error(
      `git ${args.join(' ')} failed (exit ${e.status ?? '?'}) in ${cwd}\n` +
        `stderr: ${txt(e.stderr) || '(비어 있음)'}\nstdout: ${txt(e.stdout) || '(비어 있음)'}`
    )
  const refused = (e: SpawnError): boolean =>
    txt(e.stderr) === '' &&
    txt(e.stdout) === '' &&
    ((typeof e.code === 'string' && SPAWN_REFUSED.has(e.code)) ||
      e.status == null ||
      e.status === -1 ||
      e.status === 4294967295)
  try {
    return attempt()
  } catch (first) {
    if (!refused(first as SpawnError)) throw describe(first as SpawnError)
    // A synchronous fixture cannot await; the short wait is the whole point, so it is spent here.
    const until = Date.now() + RETRY_DELAY_MS
    while (Date.now() < until) {
      /* spin */
    }
    try {
      return attempt()
    } catch (second) {
      throw describe(second as SpawnError)
    }
  }
}

/** 커밋 1개를 가진 임시 git repo. worktrees 테스트 전용 픽스처. */
export async function makeRepo(prefix = 'astera-wt-git-'): Promise<string> {
  const dir = await tempDir(prefix)
  // git의 stderr를 에러에 싣는다. execFileSync가 던지는 Error의 message는 "Command failed: git
  // commit -m init"뿐이라, 이 픽스처가 간헐적으로 실패했을 때 원인을 가릴 근거가 하나도 남지
  // 않았다 — 실제로 한 번 겪었고 stderr가 없어 규명하지 못했다.
  const run = (args: string[]): void => { gitSync(dir, args) }
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 't@t.com'])
  run(['config', 'user.name', 'Test User'])
  await fs.writeFile(path.join(dir, 'f.txt'), 'x', 'utf8')
  run(['add', 'f.txt'])
  run(['commit', '-m', 'init'])
  return dir
}

/** bare origin을 붙이고 push + origin/HEAD 설정 — 원격 base 케이스용. bare repo 경로를 반환. */
export async function addOrigin(repo: string): Promise<string> {
  const bare = await tempDir('astera-wt-origin-')
  gitSync(bare, ['init', '--bare', '-b', 'main'])
  gitSync(repo, ['remote', 'add', 'origin', bare])
  gitSync(repo, ['push', '-u', 'origin', 'main'])
  gitSync(repo, ['remote', 'set-head', 'origin', 'main'])
  return bare
}
