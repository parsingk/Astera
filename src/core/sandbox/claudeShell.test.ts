// Claude Code's shell on Windows, in Codex's sandbox (claude shell sandbox design D2, D3, D7): the wrapper named in
// CLAUDE_CODE_SHELL_PREFIX and the boot script it runs inside `codex sandbox`. The bash-driven tests run the real scripts
// through Git Bash against a fake codex: a bash script that records its arguments, folder and environment, then runs what
// follows `--` as `codex sandbox` would.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findGitBash } from '../sessions/gitBash'
import {
  SHELL_BOOT_FILE,
  SHELL_BOOT_SCRIPT,
  SHELL_PINNED_ENV,
  SHELL_WRAP_FILE,
  TOOL_MARKS,
  bashRunnable,
  claudeShellEnv,
  shellWrapScript,
  type ClaudeShellPlan
} from './claudeShell'

const BS = String.fromCharCode(92)
const slashed = (p: string): string => p.split(BS).join('/')
// A single-quoted bash word, as the builder writes one
const sq = (s: string): string => `'${s.split("'").join(`'${BS}''`)}'`

const plan = (over: Partial<ClaudeShellPlan> = {}): ClaudeShellPlan => ({
  codex: 'C:/Users/a b/codex.exe',
  codexHome: 'C:/Users/a b/.codex',
  bash: 'C:/Program Files/Git/bin/bash.exe',
  root: 'C:/w/repo',
  args: ['-c', 'x=1'],
  bootFile: 'C:/p/sandbox-settings/k/shell-boot.sh',
  ...over
})

describe('shellWrapScript text', () => {
  it('is a bash script with LF line ends, and the boot script too', () => {
    for (const text of [shellWrapScript(plan()), SHELL_BOOT_SCRIPT]) {
      expect(text.startsWith('#!/bin/bash\n')).toBe(true)
      expect(text).not.toContain('\r')
    }
    expect(SHELL_WRAP_FILE).toBe('shell-wrap.sh')
    expect(SHELL_BOOT_FILE).toBe('shell-boot.sh')
    expect(TOOL_MARKS).toEqual(['shell-snapshots/snapshot-', 'pwd -P >|'])
  })

  it('embeds each value as one single-quoted word: a space, a single quote, a double quote and Korean survive', () => {
    const odd = `C:/폴더 a/it's "q"`
    const text = shellWrapScript(plan({ codex: `${odd}/codex.exe`, codexHome: `${odd}/home`, bash: `${odd}/bash.exe`, root: `${odd}/root`, bootFile: `${odd}/boot.sh`, args: ['-c', odd] }))
    for (const word of [`${odd}/codex.exe`, `${odd}/home`, `${odd}/bash.exe`, `${odd}/root`, `${odd}/boot.sh`, odd]) expect(text, word).toContain(sq(word))
    expect(sq("it's")).toBe(`'it'${BS}''s'`)
  })

  it('forward-slashes the paths bash runs or enters, and leaves the -c values and the codex home as given', () => {
    const value = `"C:${BS}x y"="deny"`
    const text = shellWrapScript(plan({ codex: `C:${BS}c${BS}codex.exe`, bash: `C:${BS}g${BS}bash.exe`, root: `C:${BS}w`, bootFile: `C:${BS}p${BS}boot.sh`, codexHome: `C:${BS}h`, args: ['-c', value] }))
    for (const word of ['C:/c/codex.exe', 'C:/g/bash.exe', 'C:/w', 'C:/p/boot.sh', `C:${BS}h`, value]) expect(text, word).toContain(sq(word))
  })

  it('unsets CODEX_HOME for codex when the plan has no home', () => {
    expect(shellWrapScript(plan({ codexHome: null }))).toContain('unset CODEX_HOME')
    expect(shellWrapScript(plan())).not.toContain('unset CODEX_HOME')
  })
})

describe('claudeShellEnv', () => {
  it('names the wrapper, forward-slashed, turns the PowerShell tool off and pins the bash start-up scripts empty', () => {
    expect(SHELL_PINNED_ENV).toEqual({ BASH_ENV: '', ENV: '' })
    expect(claudeShellEnv(`C:${BS}p q${BS}shell-wrap.sh`)).toEqual({
      CLAUDE_CODE_SHELL_PREFIX: 'C:/p q/shell-wrap.sh',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '0',
      BASH_ENV: '',
      ENV: ''
    })
  })
})

describe('bashRunnable', () => {
  const has = (...paths: string[]) => (p: string): boolean => paths.includes(p)
  it('an .exe as it is', () => {
    expect(bashRunnable(`C:${BS}b${BS}codex.exe`, has())).toBe(`C:${BS}b${BS}codex.exe`)
    expect(bashRunnable('C:/b/codex.EXE', has())).toBe('C:/b/codex.EXE')
  })
  it("a .cmd or .bat shim's extension-less sh shim beside it, when that is there", () => {
    expect(bashRunnable(`C:${BS}npm${BS}codex.cmd`, has(`C:${BS}npm${BS}codex`))).toBe(`C:${BS}npm${BS}codex`)
    expect(bashRunnable('C:/npm/codex.BAT', has('C:/npm/codex'))).toBe('C:/npm/codex')
    expect(bashRunnable(`C:${BS}npm${BS}codex.cmd`, has())).toBeNull()
  })
  it('anything else is not runnable', () => {
    expect(bashRunnable('C:/x/codex.ps1', has('C:/x/codex'))).toBeNull()
    expect(bashRunnable('C:/x/codex', has('C:/x/codex'))).toBeNull()
  })
})

// The bash-driven half. Production runs the wrapper on Windows only, so this runs where Git Bash is found on Windows.
const gitBash = ((): string | null => {
  if (process.platform !== 'win32') return null
  const { CLAUDE_CODE_GIT_BASH_PATH: own, ...env } = process.env
  const found = findGitBash(env, existsSync) ?? (own && existsSync(own) ? own : null)
  return found ? slashed(found) : null
})()

// This process runs inside Claude Code inside Astera: none of their variables may reach the scripts under test
const baseEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(ASTERA_|CLAUDE_|CODEX_|CLAUDECODE|MSYS_NO_PATHCONV$|MSYS2_ARG_CONV_EXCL$)/i.test(k)) continue
    env[k] = v
  }
  return env
}

const FAKE_CODEX = (dir: string): string => `#!/bin/bash
d=${sq(dir)}
printf x >> "$d/codex.calls"
pwd -W > "$d/codex.cwd"
for a in "$@"; do printf '%s\\0' "$a"; done > "$d/codex.args"
printf '%s\\n' "\${CODEX_HOME-<unset>}" "\${MSYS_NO_PATHCONV-<unset>}" "\${MSYS2_ARG_CONV_EXCL-<unset>}" > "$d/codex.env"
while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done
shift
"$@"
`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Kit {
  dir: string
  root: string
  bash: string
  plan: ClaudeShellPlan
  wrapFile: string
  run(args: string[], o?: { cwd?: string; env?: Record<string, string>; input?: string }): { out: string; err: string; code: number | null }
  codexCalls(): number
  codexArgs(): string[]
  codexCwd(): string
  codexEnv(): { home: string; noPathConv: string; argConvExcl: string }
}

// A folder whose name holds a space and a single quote, so every path the wrapper embeds is one that needs quoting
function kit(over: Partial<ClaudeShellPlan> = {}): Kit {
  const bash = gitBash as string
  const dir = slashed(mkdtempSync(path.join(os.tmpdir(), "astera claude'shell-")))
  dirs.push(dir)
  const root = `${dir}/root`
  mkdirSync(`${root}/sub`, { recursive: true })
  writeFileSync(`${dir}/codex`, FAKE_CODEX(dir))
  const p: ClaudeShellPlan = { codex: `${dir}/codex`, codexHome: null, bash, root, args: [], bootFile: `${dir}/${SHELL_BOOT_FILE}`, ...over }
  writeFileSync(p.bootFile, SHELL_BOOT_SCRIPT)
  const wrapFile = `${dir}/${SHELL_WRAP_FILE}`
  writeFileSync(wrapFile, shellWrapScript(p))
  const read = (name: string): string => (existsSync(`${dir}/${name}`) ? readFileSync(`${dir}/${name}`, 'utf8') : '')
  return {
    dir,
    root,
    bash,
    plan: p,
    wrapFile,
    // As Claude Code calls it, `<git bash> -c "<prefix> '<cmd>'"` (spec M1). The arguments travel in variables: Git's
    // bin/bash.exe launcher drops a command line much over 8 000 characters (the long payloads), on both sides alike
    run: (args, o = {}) => {
      const vars = Object.fromEntries(args.map((a, i) => [`T_ARG${i}`, a]))
      const line = `"$T_WRAP"${args.map((_, i) => ` "$T_ARG${i}"`).join('')}`
      const env = { ...(o.env ?? baseEnv()), T_WRAP: wrapFile, ...vars }
      const r = spawnSync(bash, ['-c', line], { cwd: o.cwd ?? `${root}/sub`, env, input: o.input, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      if (r.error) throw r.error
      return { out: r.stdout, err: r.stderr, code: r.status }
    },
    codexCalls: () => read('codex.calls').length,
    codexArgs: () => read('codex.args').split('\0').slice(0, -1),
    codexCwd: () => read('codex.cwd').trim(),
    codexEnv: () => {
      const [home, noPathConv, argConvExcl] = read('codex.env').split('\n')
      return { home, noPathConv, argConvExcl }
    }
  }
}

// A Bash tool command as Claude Code 2.1.325 hands it to the prefix (spec M2)
const shaped = (cmd: string, cwdFile: string): string =>
  `source /c/none/shell-snapshots/snapshot-bash-0-x.sh 2>/dev/null || true && eval ${sq(cmd)} < /dev/null && pwd -P >| ${sq(cwdFile)}`
const withProject = (): Record<string, string> => ({ ...baseEnv(), CLAUDE_PROJECT_DIR: 'C:/w/repo' })
const sameFolder = (a: string, b: string): boolean => slashed(a).replace(/\/+$/, '').toLowerCase() === slashed(b).replace(/\/+$/, '').toLowerCase()

describe.runIf(gitBash !== null)('the wrapper through Git Bash', () => {
  it('sends a Bash tool command to codex', () => {
    const k = kit()
    const r = k.run([shaped('echo hi', `${k.dir}/cwd-out`)])
    expect(r).toMatchObject({ out: 'hi\n', code: 0 })
    expect(k.codexCalls()).toBe(1)
  })

  it('runs a hook command directly when CLAUDE_PROJECT_DIR is set, with its stdin', () => {
    const k = kit()
    const r = k.run(['cat; echo " direct"'], { env: withProject(), input: 'from claude' })
    expect(r).toMatchObject({ out: 'from claude direct\n', code: 0 })
    expect(k.codexCalls()).toBe(0)
  })

  // Any non-empty value counts as set, whitespace too; an empty argument passes on and runs nothing
  it('passes a hook on with a whitespace CLAUDE_PROJECT_DIR, and an empty argument with it set', () => {
    const k = kit()
    expect(k.run(['echo direct'], { env: { ...baseEnv(), CLAUDE_PROJECT_DIR: ' ' } })).toMatchObject({ out: 'direct\n', code: 0 })
    expect(k.run([''], { env: withProject() })).toMatchObject({ out: '', err: '', code: 0 })
    expect(k.codexCalls()).toBe(0)
  })

  it('sends a hook-shaped command to codex when CLAUDE_PROJECT_DIR is not set, or set empty', () => {
    const k = kit()
    expect(k.run(['echo hook']).out).toBe('hook\n')
    expect(k.run(['echo hook'], { env: { ...baseEnv(), CLAUDE_PROJECT_DIR: '' } }).out).toBe('hook\n')
    expect(k.codexCalls()).toBe(2)
  })

  it('sends a command holding either mark to codex even with CLAUDE_PROJECT_DIR set', () => {
    const k = kit()
    k.run([shaped('echo hi', `${k.dir}/cwd-out`)], { env: withProject() })
    k.run(['echo x; pwd -P >| /dev/null'], { env: withProject() })
    k.run(['echo shell-snapshots/snapshot-'], { env: withProject() })
    expect(k.codexCalls()).toBe(3)
  })

  // Measured 2026-11-16: for a command that needs no quoting Claude Code sends `eval whoami`, not `eval 'whoami'`; the
  // prototype matched on `eval '` and ran it outside. The rule is the marks and CLAUDE_PROJECT_DIR, nothing else.
  it('sends the unquoted tool shape to codex, with CLAUDE_PROJECT_DIR set or not, and the pwd tail alone too', () => {
    const k = kit()
    const unquoted = 'source /c/none/shell-snapshots/snapshot-bash-0-x.sh 2>/dev/null || true && eval whoami < /dev/null && pwd -P >| /tmp/x-cwd'
    k.run([unquoted])
    expect(k.codexCalls()).toBe(1)
    k.run([unquoted], { env: withProject() })
    expect(k.codexCalls()).toBe(2)
    k.run(['export TEMP=/tmp && eval whoami < /dev/null && pwd -P >| /tmp/x-cwd'], { env: withProject() })
    expect(k.codexCalls()).toBe(3)
  })

  it('runs nothing outside with no argument or more than one', () => {
    const k = kit()
    expect(k.run([], { env: withProject() }).code).toBe(0)
    k.run(['echo a', 'echo b'], { env: withProject() })
    expect(k.codexCalls()).toBe(2)
  })

  it('hands codex the plan\'s -c values byte for byte, then -- and the boot script under Git Bash', () => {
    const args = ['-c', `permissions={astera={filesystem={"C:/x y"="deny", "/c/path"="read"}}}`, '-c', `it's "q" ${BS}n 한글`, '-c', 'windows.sandbox="elevated"']
    const k = kit({ args })
    k.run([shaped('true', `${k.dir}/cwd-out`)])
    expect(k.codexArgs()).toEqual(['sandbox', ...args, '--', k.bash, k.plan.bootFile])
  })

  it('sets the MSYS conversion switches for codex only, and no ASTERA_SBX_ variable reaches the command', () => {
    const k = kit()
    const r = k.run([shaped('echo "${MSYS_NO_PATHCONV-u} ${MSYS2_ARG_CONV_EXCL-u} ${ASTERA_SBX_SCRIPT-u} ${ASTERA_SBX_CWD-u} ${ASTERA_SBX_CODEX_HOME-u}"', `${k.dir}/cwd-out`)])
    expect(r.out).toBe('u u u u u\n')
    expect(k.codexEnv()).toMatchObject({ noPathConv: '1', argConvExcl: '*' })
  })

  // A session may set them for itself (people set MSYS_NO_PATHCONV=1 globally for docker): the command inside gets them
  // as `bash -c` outside would, set, set empty or unset, while codex always gets the wrapper's own (review finding 2)
  it("gives the command the session's own MSYS switches, set, set empty or unset", () => {
    const show = 'echo "${MSYS_NO_PATHCONV-u}|${MSYS2_ARG_CONV_EXCL-u}|${ASTERA_SBX_MSYS_NO_PATHCONV-u}|${ASTERA_SBX_MSYS2_ARG_CONV_EXCL-u}"'
    const k = kit()
    expect(k.run([shaped(show, `${k.dir}/cwd-out`)], { env: { ...baseEnv(), MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '' } }).out).toBe('1||u|u\n')
    expect(k.codexEnv()).toMatchObject({ noPathConv: '1', argConvExcl: '*' })
    expect(k.run([shaped(show, `${k.dir}/cwd-out`)], { env: { ...baseEnv(), MSYS_NO_PATHCONV: '', MSYS2_ARG_CONV_EXCL: '/c/x;--y' } }).out).toBe('|/c/x;--y|u|u\n')
    expect(k.run([shaped(show, `${k.dir}/cwd-out`)]).out).toBe('u|u|u|u\n')
    expect(k.codexEnv()).toMatchObject({ noPathConv: '1', argConvExcl: '*' })
  })

  it("gives codex the plan's CODEX_HOME and the command the session's own, set or unset", () => {
    const show = 'echo "${CODEX_HOME-unset}"'
    const k = kit({ codexHome: 'C:/codex home/acct' })
    expect(k.run([shaped(show, `${k.dir}/cwd-out`)], { env: { ...baseEnv(), CODEX_HOME: 'C:/own home' } }).out).toBe('C:/own home\n')
    expect(k.codexEnv().home).toBe('C:/codex home/acct')
    expect(k.run([shaped(show, `${k.dir}/cwd-out`)]).out).toBe('unset\n')
    expect(k.codexEnv().home).toBe('C:/codex home/acct')
    const none = kit({ codexHome: null })
    expect(none.run([shaped(show, `${none.dir}/cwd-out`)], { env: { ...baseEnv(), CODEX_HOME: 'C:/own home' } }).out).toBe('C:/own home\n')
    expect(none.codexEnv().home).toBe('<unset>')
  })

  it("starts codex in the session's folder and the command in its own folder", () => {
    const k = kit()
    const r = k.run([shaped('pwd -W', `${k.dir}/cwd-out`)], { cwd: `${k.root}/sub` })
    expect(sameFolder(r.out.trim(), `${k.root}/sub`), r.out).toBe(true)
    expect(sameFolder(k.codexCwd(), k.root), k.codexCwd()).toBe(true)
    // Claude Code's cwd capture (`pwd -P`, MSYS form) still sees the command's folder
    expect(readFileSync(`${k.dir}/cwd-out`, 'utf8').trim()).toMatch(/\/root\/sub$/)
  })

  it("exits 125 with a line on stderr when the session's folder cannot be entered, without starting codex", () => {
    const k = kit()
    rmSync(k.root, { recursive: true, force: true })
    const r = k.run([shaped('echo no', `${k.dir}/cwd-out`)], { cwd: k.dir })
    expect(r.code).toBe(125)
    expect(r.err).toContain('astera')
    expect(r.out).toBe('')
    expect(k.codexCalls()).toBe(0)
  })

  it("the boot script exits 126 with a line on stderr when the command's folder cannot be entered", () => {
    const k = kit()
    const r = spawnSync(k.bash, [k.plan.bootFile], { cwd: k.root, env: { ...baseEnv(), ASTERA_SBX_SCRIPT: 'echo ran', ASTERA_SBX_CWD: `${k.dir}/missing` }, encoding: 'utf8', windowsHide: true })
    expect(r.status).toBe(126)
    expect(r.stderr).toContain('missing')
    expect(r.stdout).toBe('')
  })

  // The payloads of the measured kit (F:\astera-work\scratch\winsbx\pfx\fidelity.cjs): the same stdout, stderr and exit
  // code through the wrapper as through `bash -c` directly
  const long = (n: number): string => `x=${'a'.repeat(n)}; echo \${#x}`
  const payloads: Record<string, string> = {
    korean: `echo "한글 테스트 — 따옴표 'a' \\"b\\""`,
    dollars: `v=1; echo "$v \\$v $(echo sub) \`echo tick\`"`,
    backslash: `printf '%s\\n' 'C:\\Users\\x' "a\\\\b"`,
    heredoc: `cat <<'EOF'\nline one $HOME\n  line "two"\nEOF`,
    pathish: `printf '%s\\n' /c/Users /c/a:/d/b --opt=/usr/bin //server/share 'C:/x;D:/y'`,
    nativeArgs: `node -e "console.log(process.argv.slice(1).join('|'))" /c/Users --opt=/usr/bin 'a b' "q\\"q"`,
    exit3: `echo before; exit 3`,
    stderr: `echo out; echo err >&2; false`,
    pipeline: `printf 'b\\na\\n' | sort | tr a-z A-Z; echo "rc=\${PIPESTATUS[0]}"`,
    long8k: long(8000),
    long20k: long(20000),
    long30k: long(30000),
    // bash itself writes the error, naming $0 and the line, and the command sees what `bash -c` would (review finding 1)
    shellError: `nosuchcmd_zz; echo "$0"`,
    shellState: `echo "$-|\${BASH_SOURCE[0]-none}|\${BASH_ARGV0-none}|\${__astera_s-none}|\${__astera_d-none}|\${__astera_h-none}"`
  }

  it('gives a command that is not in the tool shape exactly what `bash -c` gives, errors included', () => {
    const k = kit()
    for (const cmd of [payloads.shellError, payloads.shellState, 'echo "$(declare -p | grep -c __astera)"']) {
      const d = spawnSync(k.bash, ['-c', 'bash -c "$T_ARG0"'], { cwd: `${k.root}/sub`, env: { ...baseEnv(), T_WRAP: k.wrapFile, T_ARG0: cmd }, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      const w = k.run([cmd])
      expect({ out: w.out, err: w.err, code: w.code }, cmd).toEqual({ out: d.stdout, err: d.stderr, code: d.status })
    }
    expect(k.codexCalls()).toBe(3)
  })
  it('passes the measured payloads through unchanged', { timeout: 120_000 }, () => {
    expect(payloads.backslash).toContain(BS)
    const k = kit()
    let calls = 0
    for (const [name, cmd] of Object.entries(payloads)) {
      const line = shaped(cmd, `${k.dir}/cwd-out`)
      const d = spawnSync(k.bash, ['-c', 'bash -c "$T_ARG0"'], { cwd: `${k.root}/sub`, env: { ...baseEnv(), T_WRAP: k.wrapFile, T_ARG0: line }, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      if (name.startsWith('long')) expect(d.stdout, name).toBe(`${name.slice(4, -1)}000\n`)
      expect(d.stdout + d.stderr, name).not.toBe('')
      const w = k.run([line])
      expect({ out: w.out, err: w.err, code: w.code }, name).toEqual({ out: d.stdout, err: d.stderr, code: d.status })
      expect(k.codexCalls(), name).toBe(++calls)
    }
  })
})
