// macOS GUI 앱의 PATH 복구.
//
// Finder(또는 Dock, LaunchServices)로 실행된 .app은 로그인 셸을 거치지 않으므로 launchd의 기본
// PATH(/usr/bin:/bin:/usr/sbin:/sbin)만 받는다. 이 앱이 spawn하는 것은 전부 사용자가 직접 설치한
// 도구다 — claude(~/.local/bin), codex(npm 전역), git(Xcode CLT 또는 homebrew), node, gradle.
// 복구하지 않으면 세션 생성이 통째로 실패한다.
//
// 왜 process.env.PATH를 직접 고치는가: 세션 env는 SessionManager.spawn이 { ...process.env }로
// 만들고(core/sessions/manager.ts:153), TerminalManager의 exists()는 process.env.PATH를 직접 읽으며
// (main/terminalManager.ts:15), jdkScanner와 git spawn도 마찬가지다. 한 곳을 고치면 전부 따라온다.
//
// 왜 로그인 셸을 실제로 실행하는가: PATH는 .zshrc/.zprofile/.bash_profile 어디서든 조립될 수 있고,
// homebrew·mise·asdf·nvm은 전부 rc 파일에서 shellenv를 evaluate한다. 정적으로 후보 디렉터리를
// 나열하는 방식은 그 어느 것도 잡지 못한다.
import { execFile } from 'node:child_process'

/** 마커로 감싸서 rc 파일이 뱉는 배너·경고와 PATH를 구분한다. */
const START = '__ASTERA_PATH__'
const END = '__END__'
const PROBE = `printf '%s%s%s' '${START}' "$PATH" '${END}'`

/** rc 파일이 무한 대기(예: 입력을 기다리는 프롬프트)에 빠져도 기동을 막지 않도록 한다. */
const PROBE_TIMEOUT_MS = 5_000

/** 프로브 출력에서 PATH만 뽑는다. 마커가 없거나 사이가 비면 null. */
export function parseLoginPath(stdout: string): string | null {
  const start = stdout.indexOf(START)
  if (start === -1) return null
  const from = start + START.length
  const end = stdout.indexOf(END, from)
  if (end === -1) return null
  const value = stdout.slice(from, end).trim()
  return value === '' ? null : value
}

/**
 * 로그인 PATH를 앞에, 기존 PATH의 나머지를 뒤에 둔다.
 *
 * 왜 대체가 아니라 병합인가: launchd가 넣어준 항목 중 로그인 셸에 없는 것이 있을 수 있고
 * (관리형 Mac의 MDM 프로파일 등), 그것들을 잃으면 잃은 줄도 모른다. 왜 로그인 PATH가 앞인가:
 * 사용자가 rc 파일에서 앞에 둔 순서(예: homebrew를 /usr/bin보다 앞)가 그 사용자의 의도다.
 */
export function mergePath(current: string | undefined, loginPath: string | null): string | undefined {
  if (loginPath === null) return current
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of [...loginPath.split(':'), ...(current ?? '').split(':')]) {
    if (part === '' || seen.has(part)) continue
    seen.add(part)
    out.push(part)
  }
  return out.length > 0 ? out.join(':') : current
}

/** 로그인 셸에게 PATH를 물어본다. darwin이 아니면 셸을 실행조차 하지 않는다. */
export async function readLoginPath(opts: {
  platform: NodeJS.Platform
  shell: string | undefined
  run: (file: string, args: string[]) => Promise<string>
}): Promise<string | null> {
  if (opts.platform !== 'darwin') return null
  // SHELL이 비는 경우는 드물지만, 비면 macOS 기본값인 zsh를 쓴다.
  const shell = opts.shell || '/bin/zsh'
  try {
    // -i(interactive)까지 주는 이유: nvm·mise 같은 버전 매니저는 .zshrc에서만 초기화되고,
    // .zshrc는 비대화형 셸에서 읽히지 않는 경우가 많다.
    return parseLoginPath(await opts.run(shell, ['-ilc', PROBE]))
  } catch {
    return null // 프로브 실패가 앱 기동을 막아서는 안 된다
  }
}

function runShell(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      // 종료 코드가 0이 아니어도 stdout에 마커가 있으면 성공으로 친다 — rc 파일 마지막 명령이
      // 실패해 셸이 non-zero로 끝나는 경우가 흔하다.
      if (err && !stdout) reject(err)
      else resolve(stdout)
    })
  })
}

/** process.env.PATH를 로그인 셸 PATH로 갱신한다. darwin이 아니면 아무것도 하지 않는다. */
export async function applyLoginPath(log: (m: string) => void): Promise<void> {
  const before = process.env.PATH
  const loginPath = await readLoginPath({
    platform: process.platform,
    shell: process.env.SHELL,
    run: runShell
  })
  if (loginPath === null) {
    if (process.platform === 'darwin') log('loginPath: probe failed, keeping the launchd PATH')
    return
  }
  const merged = mergePath(before, loginPath)
  if (merged && merged !== before) {
    process.env.PATH = merged
    log(`loginPath: PATH restored from ${process.env.SHELL || '/bin/zsh'}`)
  }
}
