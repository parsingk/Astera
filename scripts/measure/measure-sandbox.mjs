// The macOS and Linux measurement (enforce and sandbox design §8, E4), run by .github/workflows/measure-sandbox.yml on
// a GitHub-hosted runner and nowhere else: it writes fake credentials into the home folder (~/.ssh, ~/.aws, gh, npm,
// git's stored logins, kube, docker, gcloud), the shell startup files, and a fake item in the login keychain (macOS) or
// the keyring the workflow unlocks (Linux). Without any login it measures:
// - the sandbox probes (probes.mjs) with no sandbox, in Codex's `:workspace`, in the profile S2 means to use, and in
//   Claude's sandbox runtime (`srt`) with the settings S2 means to pass, with the session in a repository and in a
//   worktree; on macOS the S2 sets again with the keychains folder denied, on Linux Codex's with the session bus denied;
// - the Credentials list's login presets against their own tools (presets.mjs);
// - which shell startup files each shell mode reads (shells.mjs);
// - what starting the Enforce hook costs with node and with Electron as node (latency.mjs).
// It writes measure-results/<platform>.json after each part, and a summary for the job page.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROBES, probeTable, runProbes, runSet } from './probes.mjs'
import { measurePresets } from './presets.mjs'
import { measureShells } from './shells.mjs'
import { extractHookSource, measureHook } from './latency.mjs'

/** E6's sensitive locations, the same list for Codex's profile and Claude's sandbox settings. */
const SENSITIVE = ['~/.ssh', '~/.aws', '~/.config/gh', '~/.config/gcloud', '~/.docker', '~/.kube', '~/.npmrc', '~/.git-credentials']

/** What an S2 set denies reading: SENSITIVE, and on macOS with `keychains` the login keychain's folder too. Found by
 *  the first run: both S2 sets read a keychain item on macOS, since Codex's network policy and srt let the sandboxed
 *  command reach com.apple.SecurityServer. */
export function s2Denied(platform, keychains = false) {
  return platform === 'darwin' && keychains ? [...SENSITIVE, '~/Library/Keychains'] : SENSITIVE
}

/** The environment the probes run in: the job's GitHub tokens taken away, since only gh's preset run needs one (final
 *  review M9). */
export function probeEnv(env, home, port) {
  const e = { ...env, HOME: home, ASTERA_PROBE_PORT: port }
  delete e.GH_TOKEN
  delete e.GITHUB_TOKEN
  return e
}

/** TOML for a `-c` value: a string as a basic string. */
const toml = (s) => JSON.stringify(s)

/** Protecting a worktree's common directory: writable for commits, its hooks and config not (final review I1). */
const commonHooks = (commonDir) => [`${commonDir}/hooks`, `${commonDir}/config`]

/** Codex's `-c` arguments for the profile S2 means to pass (§6), with the session in a repository (`layout` 'repo') or
 *  in a worktree, whose `.git` is a file. */
export function codexS2Args({ layout, commonDir, denied }) {
  const filesystem = [
    ...(layout === 'repo' ? [`${toml(':workspace_roots')}={".git"="write", ".git/hooks"="read", ".git/config"="read"}`] : []),
    `${toml(commonDir)}="write"`,
    ...commonHooks(commonDir).map((p) => `${toml(p)}="read"`),
    ...denied.map((p) => `${toml(p)}="deny"`)
  ].join(', ')
  return ['-c', `permissions={probe2={extends=":workspace", filesystem={${filesystem}}, network={enabled=true}}}`, '-c', 'default_permissions="probe2"']
}

/** Claude's sandbox runtime settings S2 means to pass (§6). In a worktree nothing is said under `.git`, a file: srt
 *  could not mount there. */
export function srtS2Settings({ layout, commonDir, denied, tmp }) {
  return {
    network: { allowedDomains: ['example.com', 'registry.npmjs.org'], deniedDomains: [] },
    filesystem: {
      denyRead: denied,
      allowRead: [],
      allowWrite: ['.', tmp, commonDir],
      denyWrite: [...(layout === 'repo' ? ['.git/hooks', '.git/config'] : []), ...commonHooks(commonDir)]
    }
  }
}

/** srt's arguments for one probe: `--` ends srt's own options, which would take `sh -c`'s `-c` as its own and run the
 *  line with bash (final review M3). */
export const srtArgv = (settings, line) => ['--settings', settings, '--', 'sh', '-c', line]

/** The session bus socket `DBUS_SESSION_BUS_ADDRESS` names by path, or null. */
export function busSocket(env) {
  const m = /(?:^|;)unix:(?:[^;]*,)?path=([^,;]+)/.exec(env.DBUS_SESSION_BUS_ADDRESS ?? '')
  return m ? m[1] : null
}

const sh = (argv, o = {}) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120_000, ...o })
  return {
    missing: r.error?.code === 'ENOENT',
    timedOut: r.error?.code === 'ETIMEDOUT',
    code: typeof r.status === 'number' ? r.status : null,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`
  }
}
const firstLine = (argv) => sh(argv).out.split('\n')[0].trim()

/** A fresh git repository at `dir` with one commit. */
function repo(dir, env) {
  mkdirSync(dir, { recursive: true })
  for (const argv of [
    ['git', 'init', '-q', '-b', 'main'],
    ['sh', '-c', 'echo hi > readme.txt'],
    ['git', 'add', 'readme.txt'],
    ['git', '-c', 'user.name=p', '-c', 'user.email=p@p', 'commit', '-qm', 'init']
  ])
    if (sh(argv, { cwd: dir, env }).code !== 0) throw new Error(`could not make the repository ${dir}: ${argv.join(' ')}`)
}

/** A workspace repository of its own for one probe set, with a worktree `wt` of a repository outside it: a set never
 *  sees what the one before it committed or wrote into `.git`. */
function workspaceFor(home, name, env) {
  const workspace = path.join(home, `astera-probe-ws-${name}`)
  const main = path.join(home, `astera-probe-main-${name}`)
  repo(workspace, env)
  repo(main, env)
  if (sh(['git', 'worktree', 'add', '-q', path.join(workspace, 'wt'), '-b', 'probe'], { cwd: main, env }).code !== 0) throw new Error('could not add the worktree')
  appendFileSync(path.join(workspace, '.git', 'info', 'exclude'), 'wt/\n')
  return { name, workspace, worktree: path.join(workspace, 'wt'), commonDir: path.join(main, '.git') }
}

/** The fake home files and git's stored login, in `env`'s home. */
function fixtures(home, env) {
  const write = (rel, text) => {
    const file = path.join(home, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  write('astera-probe-home.txt', 'home\n')
  write('.ssh/astera-probe-key', 'fake key\n')
  write('.aws/credentials', '[default]\naws_access_key_id = AKIAASTERAPROBE00001\naws_secret_access_key = astera-probe-fake\n')
  write('.config/gh/hosts.yml', 'github.com:\n    oauth_token: gho_astera_probe_fake\n    user: astera-probe\n')
  write('.git-credentials', 'https://astera-probe:fake@astera-probe.example\n')
  sh(['git', 'config', '--global', 'credential.helper', 'store'], { env })
  // On Linux in the session bus and unlocked keyring the workflow starts
  const keychain =
    process.platform === 'darwin'
      ? sh(['security', 'add-generic-password', '-a', 'astera', '-s', 'astera-probe', '-w', 'astera-probe-fake', '-U'], { env })
      : process.platform === 'linux'
        ? sh(['secret-tool', 'store', '--label=astera-probe', 'service', 'astera-probe'], { env, input: 'astera-probe-fake' })
        : null
  return {
    keychain: keychain === null ? 'not on this platform' : keychain.code === 0 ? 'added' : keychain.missing ? 'secret-tool is not installed' : keychain.out.slice(0, 200)
  }
}

/** A loopback HTTP server in a process of its own (the probes block this one), and its port. */
function loopbackServer() {
  const child = spawn(process.execPath, ['-e', "require('http').createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', function () { console.log(this.address().port) })"], {
    stdio: ['ignore', 'pipe', 'inherit']
  })
  return new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => resolve({ port: String(d).trim(), stop: () => child.kill() }))
    child.once('error', reject)
  })
}

/** The `codex sandbox` form this runner's codex takes, tried in the order the plan gives. */
function codexForm(profileArgs, env, cwd) {
  for (const form of [['sandbox'], ['sandbox', process.platform === 'darwin' ? 'macos' : 'linux']]) {
    const r = sh(['codex', ...form, ...profileArgs, '--', 'sh', '-c', 'true'], { env, cwd })
    if (r.code === 0) return { form, tried: null }
  }
  return { form: ['sandbox'], tried: sh(['codex', 'sandbox', ...profileArgs, '--', 'sh', '-c', 'true'], { env, cwd }).out.slice(0, 500) }
}

/** The probes a session in a worktree can run: the ones that `cd wt` assume the session is in the repository. */
const WORKTREE_PROBES = PROBES.filter((p) => !p.line.startsWith('cd wt ')).map((p) => p.id)

export async function main(o = {}) {
  const env = o.env ?? process.env
  // A self-hosted runner, a person's own machine, sets GITHUB_ACTIONS too (final review M12)
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error('measure-sandbox runs only on a GitHub-hosted runner: it writes fake credentials into the home folder')
  const home = o.home ?? os.homedir()
  const root = o.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'astera-measure-'))
  const tmp = os.tmpdir()

  // Written after each part, so a part that throws keeps what came before it (final review M8)
  const result = {
    at: new Date().toISOString(),
    platform: process.platform,
    image: { os: env.ImageOS ?? null, version: env.ImageVersion ?? null },
    versions: { node: process.version, codex: firstLine(['codex', '--version']), srt: firstLine(['srt', '--version']), git: firstLine(['git', '--version']) },
    codexSandboxHelp: sh(['codex', 'sandbox', '--help']).out.slice(0, 3000)
  }
  const outDir = path.join(root, 'measure-results')
  mkdirSync(outDir, { recursive: true })
  const save = () => writeFileSync(path.join(outDir, `${process.platform}.json`), JSON.stringify(result, null, 2))
  save()

  const homeEnv = probeEnv(env, home, '')
  result.keychain = fixtures(home, homeEnv).keychain
  const server = await loopbackServer()
  const base = probeEnv(env, home, server.port)

  // Codex: `:workspace` as it is, and the profile S2 means to pass
  const workspaceProfile = ['-c', 'permissions={probe={extends=":workspace"}}', '-c', 'default_permissions="probe"']
  const codex = (profile, form) => (line) => ({ file: 'codex', args: [...form, ...profile, '--', 'sh', '-c', line] })
  // srt hands its command TMPDIR=/tmp/claude and leaves making it to Claude Code, which makes its own (found by the
  // first run: the temp write failed on a folder that was not there)
  if (process.platform !== 'win32') mkdirSync('/tmp/claude', { recursive: true })

  // Each set on a workspace and an npm cache of its own (found by the first run: a cache the set before had filled let
  // an install without the network succeed). `layout` 'worktree' puts the session in the worktree itself, as Astera's
  // workers are.
  const at = (w, layout) => ({
    cwd: layout === 'worktree' ? w.worktree : w.workspace,
    env: { ...base, npm_config_cache: path.join(tmp, `astera-npm-cache-${w.name}`) },
    only: layout === 'worktree' ? WORKTREE_PROBES : undefined
  })
  const sh0 = (line) => ({ file: 'sh', args: ['-c', line] })
  const wPlain = workspaceFor(home, 'plain', homeEnv)
  const plain = runProbes(sh0, at(wPlain, 'repo'))
  const wCodex = workspaceFor(home, 'codex-workspace', homeEnv)
  const workspaceForm = codexForm(workspaceProfile, base, wCodex.workspace)
  result.codexSandboxForm = { form: workspaceForm.form, refused: workspaceForm.tried }
  const codexWorkspace = runSet(codex(workspaceProfile, workspaceForm.form), at(wCodex, 'repo'))
  const codexSet = (name, layout, denied) => {
    const w = workspaceFor(home, name, homeEnv)
    return runSet(codex(codexS2Args({ layout, commonDir: w.commonDir, denied }), workspaceForm.form), at(w, layout))
  }
  const srtSet = (name, layout, denied) => {
    const w = workspaceFor(home, name, homeEnv)
    const settings = path.join(scratch, `srt-settings-${name}.json`)
    writeFileSync(settings, JSON.stringify(srtS2Settings({ layout, commonDir: w.commonDir, denied, tmp })))
    return runSet((line) => ({ file: 'srt', args: srtArgv(settings, line) }), at(w, layout))
  }
  const denied = s2Denied(process.platform)
  const sets = { codexWorkspace, codexS2: codexSet('codex-s2', 'repo', denied), srtS2: srtSet('srt-s2', 'repo', denied) }
  // On macOS, the S2 sets with the keychains folder denied as well
  if (process.platform === 'darwin') {
    const withKeychains = s2Denied(process.platform, true)
    Object.assign(sets, { codexS2Keychains: codexSet('codex-s2-keychains', 'repo', withKeychains), srtS2Keychains: srtSet('srt-s2-keychains', 'repo', withKeychains) })
  }
  // On Linux, Codex's with the session bus socket denied (final review M10: whether that closes the keyring is measured)
  const bus = busSocket(base)
  if (process.platform === 'linux' && bus !== null) sets.codexS2Bus = codexSet('codex-s2-bus', 'repo', [...denied, bus])
  result.probes = { plain, ...sets }
  save()
  // The session in the worktree, against its own run with no sandbox
  const wPlainWt = workspaceFor(home, 'plain-wt', homeEnv)
  const plainWorktree = runProbes(sh0, at(wPlainWt, 'worktree'))
  const worktreeSets = { codexS2: codexSet('codex-s2-wt', 'worktree', denied), srtS2: srtSet('srt-s2-wt', 'worktree', denied) }
  result.probesWorktree = { plain: plainWorktree, ...worktreeSets }
  save()
  server.stop()

  const run = (argv, e) => sh(argv, { env: e })
  // gh's preset run reads the job's token, so only it gets the job's environment as it is
  result.presets = measurePresets(home, path.join(scratch, 'presets'), run, { ...env, HOME: home })
  save()
  result.shells = measureShells(home, run, homeEnv)
  save()

  // The Enforce hook as the build bundled it
  const chunks = path.join(root, 'out', 'main', 'chunks')
  let names = []
  try {
    names = readdirSync(chunks)
  } catch {
    // No build: said in the results below
  }
  const source = names.map((c) => extractHookSource(readFileSync(path.join(chunks, c), 'utf8'))).find((s) => s !== null) ?? null
  let latency = { error: 'no out/main chunk holds the hook: run npx electron-vite build first' }
  if (source !== null) {
    const hookDir = path.join(scratch, 'hook-profile')
    mkdirSync(hookDir, { recursive: true })
    const hookFile = path.join(hookDir, 'astera-enforce-hook.cjs')
    writeFileSync(hookFile, source)
    const interpreters = [{ name: 'node', file: process.execPath, env: {} }]
    let electronError = null
    try {
      interpreters.push({ name: 'electron-as-node', file: createRequire(path.join(root, 'package.json'))('electron'), env: { ELECTRON_RUN_AS_NODE: '1' } })
    } catch (err) {
      electronError = { error: `electron is not installed: ${String(err.message ?? err).slice(0, 200)}` }
    }
    latency = measureHook({ hookFile, runs: 20, interpreters })
    if (electronError !== null) latency['electron-as-node'] = electronError
  }
  result.latency = latency
  save()

  const summary = [
    `## ${process.platform} (${result.image.os ?? '?'} ${result.image.version ?? '?'}), ${result.versions.codex}, srt ${result.versions.srt}`,
    '',
    probeTable('Sandbox probes, the session in a repository', plain, sets),
    probeTable('Sandbox probes, the session in a worktree', plainWorktree, worktreeSets),
    '### Presets',
    '',
    '| preset | verdict |',
    '| --- | --- |',
    ...result.presets.map((p) => `| ${p.id} | ${p.verdict} |`),
    '',
    '### Shell startup files',
    '',
    '| mode | read |',
    '| --- | --- |',
    ...result.shells.map((s) => `| ${s.mode} | ${s.missing ? 'missing' : s.timedOut ? 'timeout' : s.read.join(', ') || 'none'} |`),
    '',
    '### Enforce hook start-up (ms)',
    '',
    '```',
    JSON.stringify(latency, null, 2),
    '```',
    ''
  ].join('\n')
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary)
  process.stdout.write(summary)
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err}\n`)
    process.exit(1)
  })
}
