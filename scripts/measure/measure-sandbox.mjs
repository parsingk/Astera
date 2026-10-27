// The macOS and Linux measurement (enforce and sandbox design §8, E4), run by .github/workflows/measure-sandbox.yml on
// a GitHub Actions runner and nowhere else: it writes fake credentials into the home folder (~/.ssh, ~/.aws, gh, npm,
// git's stored logins, kube, docker, gcloud) and the shell startup files. Without any login it measures:
// - the sandbox probes (probes.mjs) with no sandbox, in Codex's `:workspace`, in the profile S2 means to use, and in
//   Claude's sandbox runtime (`srt`) with the settings S2 means to pass;
// - the Credentials list's login presets against their own tools (presets.mjs);
// - which shell startup files each shell mode reads (shells.mjs);
// - what starting the Enforce hook costs with node and with Electron as node (latency.mjs).
// It writes measure-results/<platform>.json and a summary for the job page.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeTable, runProbes, runSet } from './probes.mjs'
import { measurePresets } from './presets.mjs'
import { measureShells } from './shells.mjs'
import { extractHookSource, measureHook } from './latency.mjs'

/** E6's sensitive locations, the same list for Codex's profile and Claude's sandbox settings. */
const SENSITIVE = ['~/.ssh', '~/.aws', '~/.config/gh', '~/.config/gcloud', '~/.docker', '~/.kube', '~/.npmrc', '~/.git-credentials']

const sh = (argv, o = {}) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120_000, ...o })
  return { missing: r.error?.code === 'ENOENT', code: typeof r.status === 'number' ? r.status : null, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
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

/** A workspace repository of its own for one probe set, with a worktree of a repository outside it: a set never sees
 *  what the one before it committed or wrote into `.git`. */
function workspaceFor(home, name, env) {
  const workspace = path.join(home, `astera-probe-ws-${name}`)
  const main = path.join(home, `astera-probe-main-${name}`)
  repo(workspace, env)
  repo(main, env)
  if (sh(['git', 'worktree', 'add', '-q', path.join(workspace, 'wt'), '-b', 'probe'], { cwd: main, env }).code !== 0) throw new Error('could not add the worktree')
  appendFileSync(path.join(workspace, '.git', 'info', 'exclude'), 'wt/\n')
  return { workspace, commonDir: path.join(main, '.git') }
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
  const keychain = process.platform === 'darwin' ? sh(['security', 'add-generic-password', '-a', 'astera', '-s', 'astera-probe', '-w', 'astera-probe-fake', '-U'], { env }) : null
  return { keychain: keychain === null ? 'not on this platform' : keychain.code === 0 ? 'added' : keychain.out.slice(0, 200) }
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

/** TOML for a `-c` value: a string as a basic string. */
const toml = (s) => JSON.stringify(s)

/** The `codex sandbox` form this runner's codex takes, tried in the order the plan gives. */
function codexForm(profileArgs, env, cwd) {
  for (const form of [['sandbox'], ['sandbox', process.platform === 'darwin' ? 'macos' : 'linux']]) {
    const r = sh(['codex', ...form, ...profileArgs, '--', 'sh', '-c', 'true'], { env, cwd })
    if (r.code === 0) return { form, tried: null }
  }
  return { form: ['sandbox'], tried: sh(['codex', 'sandbox', ...profileArgs, '--', 'sh', '-c', 'true'], { env, cwd }).out.slice(0, 500) }
}

export async function main(o = {}) {
  const env = o.env ?? process.env
  if (env.GITHUB_ACTIONS !== 'true')
    throw new Error('measure-sandbox runs only on a GitHub Actions runner: it writes fake credentials into the home folder')
  const home = o.home ?? os.homedir()
  const root = o.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'astera-measure-'))
  const tmp = os.tmpdir()

  const homeEnv = { ...env, HOME: home }
  const f = fixtures(home, homeEnv)
  const server = await loopbackServer()
  const base = { ...env, HOME: home, ASTERA_PROBE_PORT: server.port, npm_config_cache: path.join(tmp, 'astera-npm-cache') }

  // Codex: `:workspace` as it is, and the profile S2 means to pass (§6), with the worktree's common directory writable
  const workspaceProfile = ['-c', 'permissions={probe={extends=":workspace"}}', '-c', 'default_permissions="probe"']
  const s2Profile = (commonDir) => {
    const filesystem = [
      `${toml(':workspace_roots')}={".git"="write", ".git/hooks"="read", ".git/config"="read"}`,
      `${toml(commonDir)}="write"`,
      ...SENSITIVE.map((p) => `${toml(p)}="deny"`)
    ].join(', ')
    return ['-c', `permissions={probe2={extends=":workspace", filesystem={${filesystem}}, network={enabled=true}}}`, '-c', 'default_permissions="probe2"']
  }
  const codex = (profile, form) => (line) => ({ file: 'codex', args: [...form, ...profile, '--', 'sh', '-c', line] })

  // Claude's sandbox runtime with the settings S2 means to pass (§6)
  const srtSettingsFor = (commonDir) => {
    const file = path.join(scratch, 'srt-settings.json')
    writeFileSync(
      file,
      JSON.stringify({
        network: { allowedDomains: ['example.com', 'registry.npmjs.org'], deniedDomains: [] },
        filesystem: { denyRead: SENSITIVE, allowRead: [], allowWrite: ['.', tmp, commonDir], denyWrite: ['.git/hooks', '.git/config'] }
      })
    )
    return file
  }

  // Each set on a workspace of its own
  const at = (w) => ({ cwd: w.workspace, env: base })
  const wPlain = workspaceFor(home, 'plain', homeEnv)
  const plain = runProbes((line) => ({ file: 'sh', args: ['-c', line] }), at(wPlain))
  const wCodex = workspaceFor(home, 'codex-workspace', homeEnv)
  const workspaceForm = codexForm(workspaceProfile, base, wCodex.workspace)
  const codexWorkspace = runSet(codex(workspaceProfile, workspaceForm.form), at(wCodex))
  const wS2 = workspaceFor(home, 'codex-s2', homeEnv)
  const codexS2 = runSet(codex(s2Profile(wS2.commonDir), workspaceForm.form), at(wS2))
  const wSrt = workspaceFor(home, 'srt-s2', homeEnv)
  const srtSettings = srtSettingsFor(wSrt.commonDir)
  const srtS2 = runSet((line) => ({ file: 'srt', args: ['--settings', srtSettings, 'sh', '-c', line] }), at(wSrt))
  server.stop()

  const run = (argv, e) => {
    const r = sh(argv, { env: e })
    return { missing: r.missing, out: r.out }
  }
  const presets = measurePresets(home, path.join(scratch, 'presets'), run, env)
  const shells = measureShells(home, run, env)

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
    const electron = createRequire(path.join(root, 'package.json'))('electron')
    latency = measureHook({
      hookFile,
      runs: 20,
      interpreters: [
        { name: 'node', file: process.execPath, env: {} },
        { name: 'electron-as-node', file: electron, env: { ELECTRON_RUN_AS_NODE: '1' } }
      ]
    })
  }

  const result = {
    at: new Date().toISOString(),
    platform: process.platform,
    image: { os: env.ImageOS ?? null, version: env.ImageVersion ?? null },
    versions: { node: process.version, codex: firstLine(['codex', '--version']), srt: firstLine(['srt', '--version']), git: firstLine(['git', '--version']) },
    codexSandboxHelp: sh(['codex', 'sandbox', '--help']).out.slice(0, 3000),
    codexSandboxForm: { form: workspaceForm.form, refused: workspaceForm.tried },
    keychain: f.keychain,
    probes: { plain, codexWorkspace, codexS2, srtS2 },
    presets,
    shells,
    latency
  }
  const outDir = path.join(root, 'measure-results')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, `${process.platform}.json`), JSON.stringify(result, null, 2))

  const summary = [
    `## ${process.platform} (${result.image.os ?? '?'} ${result.image.version ?? '?'}), ${result.versions.codex}, srt ${result.versions.srt}`,
    '',
    probeTable('Sandbox probes', plain, { codexWorkspace, codexS2, srtS2 }),
    '### Presets',
    '',
    '| preset | verdict |',
    '| --- | --- |',
    ...presets.map((p) => `| ${p.id} | ${p.verdict} |`),
    '',
    '### Shell startup files',
    '',
    '| mode | read |',
    '| --- | --- |',
    ...shells.map((s) => `| ${s.mode} | ${s.missing ? 'missing' : s.read.join(', ') || 'none'} |`),
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

