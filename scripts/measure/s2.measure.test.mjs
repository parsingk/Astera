// The S2 measurement (the sandbox plan's Task 2; enforce and sandbox design §10 items 1-4): the sandbox builders' own
// output (src/core/sandbox) handed to each CLI's sandbox and run against the S4 probes. Every set runs in fresh
// workspaces of its own, first with no sandbox in the same layout, so "denied" is the sandbox and not the fixture.
//
// It runs on a GitHub-hosted runner with ASTERA_MEASURE_S2=1 (the workflow's S2 step, after the S4 one), or on this
// Windows PC with ASTERA_MEASURE_S2_LOCAL=1: a fake home in the temp folder, the person's own CODEX_HOME (whose sandbox
// is set up, so nothing asks for an administrator) and no model call. Anywhere else every case skips, since the run
// writes fake credentials into the home folder. It writes measure-results/<platform>-s2.json after each set.
//
// Not measurable here: Claude Code's own `--settings` sandbox keys (§10 item 4) need a logged-in Claude Code, which a
// runner does not have. The srt sets stand for it (`runtime-measured`); Claude Code itself is checked on the person's
// machines (plan Task 10).
//
// The readiness probe with a scratch CODEX_HOME may bring up Windows' administrator prompt, so it has a variable of its
// own, ASTERA_MEASURE_S2_SCRATCH_READINESS=1, and runs only after the person has been asked.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { claudeSandboxSettings } from '../../src/core/sandbox/claudeSettings'
import { codexSandboxEnv, npmCacheOf } from '../../src/core/sandbox/codexProfile'
import { codexExcludesWriter } from '../../src/core/sandbox/gitExcludes'
import { ensureGitFiles, ensureWorktreeConfigFiles, gitLayoutOf } from '../../src/core/sandbox/gitLayout'
import { initializeParams } from '../../src/core/chat/codexProtocol'
import { hostAddress } from '../../src/host/address'
import { HOST_PROTOCOL } from '../../src/core/host/protocol'
import { appKeyPath, ensureAppKey } from '../../src/core/host/hostKey'
import { fixtures, loopbackServer, probeEnv, sh, srtArgv, workspaceFor } from './measure-sandbox.mjs'
import { runProbes, runSet } from './probes.mjs'
import { startAppServer } from './appServer.mjs'
import {
  COMMON_CASE_PROBES,
  DOCTOR_ARGV,
  GLOBAL_EXCLUDE_PROBE,
  GLOBAL_IGNORED,
  READY_MARKER,
  S2_SETS,
  SOCKET_PROBE,
  WIN32_PROBE_FILES,
  brokenPlain,
  clip,
  claudeDenied,
  codexDenied,
  codexSetArgs,
  excludePatterns,
  excludesEnv,
  excludesText,
  execParams,
  execResult,
  globalExcludesPath,
  localWin32Env,
  probesFor,
  profileNameOf,
  readinessArgv,
  s2Enabled,
  s2SetNames,
  s2Table,
  s2ThreadStart,
  sanityLine,
  scratchReadinessEnabled,
  shellArgv,
  srtSettingsOf,
  nodeVersionArgv,
  threadStartRecord,
  verdicts,
  whoamiArgv,
  withoutNpmRunEnv
} from './s2.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_DIR = path.join(ROOT, 'measure-results')
const PLATFORM = process.platform
const WIN = PLATFORM === 'win32'
// The elevated Windows sandbox refreshes its folder grants on every start, so a probe there takes longer
const PROBE_MS = WIN ? 60_000 : 20_000

const plainWrap = (line) => {
  const [file, ...args] = shellArgv(PLATFORM, line)
  return { file, args }
}

/** codex run directly, with stdout apart from stderr (doctor's report is JSON on stdout), both whole: a record clips
 *  them (`clipped`), since a JSON report cut short does not parse (found by the first local run). */
function runCodex(argv, { env, cwd, timeout = 180_000 }) {
  const started = Date.now()
  const r = spawnSync('codex', argv, { env, cwd, encoding: 'utf8', timeout, windowsHide: true })
  return {
    argv,
    code: typeof r.status === 'number' ? r.status : null,
    timedOut: r.error?.code === 'ETIMEDOUT',
    missing: r.error?.code === 'ENOENT',
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ms: Date.now() - started
  }
}

const clipped = (r) => ({ ...r, stdout: r.stdout.slice(0, 4000), stderr: r.stderr.slice(0, 4000) })
const readiness = (r) => ({ ...clipped(r), ready: r.code === 0 && r.stdout.includes(READY_MARKER) })

/** The part of `codex doctor --json` that says whether the sandbox is set up. */
function doctorReport(r) {
  let parsed = null
  try {
    parsed = JSON.parse(r.stdout)
  } catch {
    // Kept as text below
  }
  const helpers = parsed?.checks?.['sandbox.helpers'] ?? null
  return {
    argv: r.argv,
    code: r.code,
    ms: r.ms,
    overallStatus: parsed?.overallStatus ?? null,
    sandboxHelpers: helpers,
    provisioning: helpers?.details?.['sandbox provisioning'] ?? null,
    ...(parsed === null ? { stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 2000) } : {})
  }
}

/** A Codex home this run may use without the administrator prompt: one whose sandbox setup is on disk. */
function assertSetUp(codexHome) {
  for (const f of ['.sandbox/setup_marker.json', '.sandbox-secrets/sandbox_users.json'])
    if (!existsSync(path.join(codexHome, f)))
      throw new Error(`${codexHome} has no ${f}: its sandbox is not set up, and codex would bring up the administrator prompt`)
}

describe.skipIf(!s2Enabled(process.env, process.platform))('S2: the sandbox builders measured', { timeout: 20 * 60_000 }, () => {
  const ctx = {}
  const result = {
    at: new Date().toISOString(),
    platform: PLATFORM,
    image: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null },
    notes: [
      'Each set: probes with no sandbox in a fresh workspace of the same layout (plain), then in the sandbox in another fresh one (sandboxed); verdicts read one against the other (probes.mjs verdict).',
      "Codex sets: codexSandboxArgs for gitLayoutOf(cwd) without its leading -a never, denied = sensitiveLocations + credentialStoreDenies, environment codexSandboxEnv with a temp folder of the set's own (on win32 with the copy of the fake home's global excludes codexExcludesWriter writes there, as the start does).",
      'srt sets: claudeSandboxSettings as Claude Code hands them to srt (s2.mjs srtSettingsOf); the network list names the probes’ hosts. Claude Code’s own use of these settings is not measured (no login): runtime-measured.',
      'The config.worktree probes write the one git names for the session, the main checkout’s and a second worktree’s (each set adds one). On the shipped path the repository has extensions.worktreeConfig on and every config.worktree made first by ensureWorktreeConfigFiles (worktreeConfig in each set), as the start does; codex-worktree-common has the extension off and none made (filesBefore, filesAfter). In the srt sets they are informational: how Claude Code itself treats a worktree’s git data is not srt’s.',
      'Every set makes the missing git files first, as every sandboxed start does (ensureGitFiles: a commondir holding `.` and an empty modules folder; gitFiles in each set), and both profiles keep them read-only with a worktree’s `.git` pointer; the normal-work probes (git-status, git-log, git-worktree-list, and the commits) say whether everyday git still runs.',
      ...(WIN
        ? [
            'win32: the fake home is in TEMP, which the sandbox may write, so write-home writes ASTERA_PROBE_OUTSIDE (a folder in the checkout, outside TEMP and the workspace); git-credential uses the store helper and the fake .git-credentials, with Git’s system config (Credential Manager) left out.',
            'win32: the workspaces are in TEMP too, so a git write allowed there may come from TEMP rather than the profile; a denied one is the profile.'
          ]
        : [])
    ],
    sets: {}
  }
  const save = () => {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(path.join(OUT_DIR, `${PLATFORM}-s2.json`), JSON.stringify(result, null, 2))
  }

  beforeAll(async () => {
    ctx.scratch = mkdtempSync(path.join(os.tmpdir(), 'astera-s2-'))
    ctx.home = WIN ? path.join(ctx.scratch, 'home') : os.homedir()
    ctx.probeDir = path.join(ctx.scratch, 'probe')
    mkdirSync(ctx.probeDir, { recursive: true })
    for (const [name, text] of Object.entries(WIN32_PROBE_FILES)) writeFileSync(path.join(ctx.probeDir, name), text)
    if (WIN) {
      ctx.codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
      assertSetUp(ctx.codexHome)
      mkdirSync(path.join(ctx.home, 'AppData', 'Roaming'), { recursive: true })
      ctx.outside = path.join(OUT_DIR, 'win32-s2-outside')
      mkdirSync(ctx.outside, { recursive: true })
    }
    const own = withoutNpmRunEnv(process.env)
    const envFor = (port) =>
      WIN ? localWin32Env({ env: own, home: ctx.home, codexHome: ctx.codexHome, probeDir: ctx.probeDir, outside: ctx.outside, port }) : probeEnv(own, ctx.home, port)
    ctx.homeEnv = envFor('')

    const firstLine = (argv) => sh(argv, { env: ctx.homeEnv }).out.split('\n')[0].trim()
    result.versions = { node: process.version, codex: firstLine(['codex', '--version']), git: firstLine(['git', '--version']), srt: WIN ? null : firstLine(['srt', '--version']) }

    // S4's fixtures, plus a ~/.npmrc (an E6 entry npm reads on every install) and a global exclude the Linux exclude
    // file has to keep
    const { keychain } = fixtures(ctx.home, ctx.homeEnv)
    appendFileSync(path.join(ctx.home, '.npmrc'), '@astera-probe:registry=https://astera-probe.example/\n')
    const configured = sh(['git', 'config', '--global', '--get', 'core.excludesFile'], { env: ctx.homeEnv }).out.trim() || null
    const globalIgnore = globalExcludesPath(configured, ctx.homeEnv, ctx.home)
    mkdirSync(path.dirname(globalIgnore), { recursive: true })
    appendFileSync(globalIgnore, `${GLOBAL_IGNORED}\n`)
    result.fixtures = { home: ctx.home, keychain, globalIgnore }

    ctx.server = await loopbackServer()
    ctx.base = envFor(ctx.server.port)
    // A profile's app key, there as the app makes it, which the Codex sets deny on every OS as a session's start does
    // (sandbox follow-ups, item 1)
    const hostProfile = path.join(ctx.scratch, 'codex-host-profile')
    await ensureAppKey(hostProfile)
    ctx.appKeyFile = appKeyPath(hostProfile)
    if (!WIN) {
      // A Host-shaped socket folder, there as a running Host's is, which the Codex sets deny as a session's start does
      ctx.hostDir = hostAddress({ profileDir: hostProfile, platform: PLATFORM, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL }).dirToPrepare
      mkdirSync(ctx.hostDir, { recursive: true, mode: 0o700 })
      // srt hands its command TMPDIR=/tmp/claude and leaves making it to Claude Code (inventory §22.9 item 8)
      mkdirSync('/tmp/claude', { recursive: true })
      result.srtLists = await srtLists()
    }
    save()
  }, 300_000)

  afterAll(async () => {
    ctx.server?.stop()
    if (ctx.hostDir) rmSync(ctx.hostDir, { recursive: true, force: true })
    const pairs = Object.fromEntries(Object.entries(result.sets).map(([n, s]) => [n, { plain: s.plain, sandboxed: s.sandboxed }]))
    const w = result.windows
    const summary = [
      `## S2, ${PLATFORM} (${result.image.os ?? 'local'} ${result.image.version ?? ''}), ${result.versions?.codex ?? '?'}, srt ${result.versions?.srt ?? '-'}`,
      '',
      s2Table('The S2 sets, each against its own run with no sandbox', pairs),
      ...(w
        ? [
            '### Windows readiness',
            '',
            `- elevated, the person's CODEX_HOME: exit ${w.readiness.code}, ready ${w.readiness.ready}`,
            `- mxc: exit ${w.mxc.code}, ready ${w.mxc.ready}`,
            `- codex sandbox setup --help: exit ${w.setupHelp.code}`,
            `- doctor: provisioning ${w.doctor.provisioning}; with a scratch CODEX_HOME: ${w.doctorScratch.provisioning}`,
            ''
          ]
        : [])
    ].join('\n')
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
    process.stdout.write(`${summary}\n`)
    save()
    // On this PC the run cleans up after itself; a runner is thrown away
    if (WIN) {
      for (const p of [ctx.scratch, ctx.outside, path.join(os.tmpdir(), 'astera-probe.txt')]) {
        if (!p) continue
        try {
          rmSync(p, { recursive: true, force: true, maxRetries: 3 })
        } catch (err) {
          process.stdout.write(`could not remove ${p}: ${err.message}\n`)
        }
      }
    }
  }, 120_000)

  /** srt's own lists, read off the installed package, to set against the exclude file's (s2.mjs). */
  async function srtLists() {
    const npmRoot = sh(['npm', 'root', '-g']).out.trim()
    const file = path.join(npmRoot, '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox', 'sandbox-utils.js')
    try {
      const m = await import(pathToFileURL(file).href)
      return { files: m.DANGEROUS_FILES, directories: m.getDangerousDirectories() }
    } catch (err) {
      return { file, error: String(err.message ?? err).slice(0, 300) }
    }
  }

  /**
   * A fresh workspace for one run, and the session folder in it for the layout. A second worktree of the session's
   * repository stands for the person's other checkouts: of the main repository beside a session in a worktree, of the
   * workspace repository (outside the workspace) for a session at its root or in a subfolder.
   * On the shipped path the repository reads config.worktree (extensions.worktreeConfig on, in the common config), and
   * every config.worktree is made first as the start makes them (`ensureWorktreeConfigFiles`). The common case
   * (`shipped: false`) has the extension off and none made.
   */
  async function prepare(name, layout, files = {}, { shipped = true } = {}) {
    const w = workspaceFor(ctx.home, `s2-${name}`, ctx.homeEnv, files)
    const addWorktree = (repoDir, at, branch) => {
      const r = sh(['git', 'worktree', 'add', '-q', at, '-b', branch], { cwd: repoDir, env: ctx.homeEnv })
      if (r.code !== 0) throw new Error(`could not add the worktree ${at}: ${r.out}`)
      return at
    }
    const siblingCheckout =
      layout === 'worktree'
        ? addWorktree(path.dirname(w.commonDir), path.join(ctx.home, `astera-probe-wt2-s2-${name}`), 'probe2')
        : addWorktree(w.workspace, path.join(ctx.home, `astera-probe-wswt-s2-${name}`), 'side')
    let cwd = w.workspace
    if (layout === 'worktree') cwd = w.worktree
    if (layout === 'subfolder') {
      cwd = path.join(w.workspace, 'sub')
      mkdirSync(cwd, { recursive: true })
    }
    const tmpDir = path.join(ctx.scratch, `tmp-${name}`)
    mkdirSync(tmpDir, { recursive: true })
    if (shipped) {
      const on = sh(['git', 'config', 'extensions.worktreeConfig', 'true'], { cwd, env: ctx.homeEnv })
      if (on.code !== 0) throw new Error(`could not turn on extensions.worktreeConfig in ${cwd}: ${on.out}`)
    }
    const gitLayout = await gitLayoutOf(cwd)
    const sibling = `${(await gitLayoutOf(siblingCheckout)).gitDir}/config.worktree`
    const native = (p) => (WIN ? path.win32.normalize(p) : p)
    const vars = {
      ASTERA_PROBE_SIBLING: native(sibling),
      ...(WIN
        ? {
            ASTERA_PROBE_HOOKS: native(`${gitLayout.commonDir}/hooks`),
            ASTERA_PROBE_GITDIR: native(gitLayout.gitDir),
            ASTERA_PROBE_COMMON: native(gitLayout.commonDir)
          }
        : {})
    }
    const worktreeConfig = shipped ? await ensureWorktreeConfigFiles(gitLayout) : { created: [], commonCase: 'extension off, none made first' }
    // Every sandboxed start makes the missing commondir files and modules folder, on every OS (final fix pass, C1)
    const gitFiles = await ensureGitFiles(gitLayout)
    // A Windows Codex start copies the global excludes into TEMP, for the sandbox's own account (gitExcludes.ts)
    const excludesFile = WIN
      ? await codexExcludesWriter({ profileDir: path.join(ctx.scratch, `profile-${name}`), tmpDir, homeDir: ctx.home, env: ctx.homeEnv, log: (m) => console.log(m) })()
      : null
    return { cwd, gitLayout, tmpDir, sibling, vars, worktreeConfig, gitFiles, excludesFile }
  }

  /** The builder's environment for a Codex session, and where the probes find the git directories. */
  function codexEnvOf(p) {
    const own = codexSandboxEnv({ platform: PLATFORM, layout: p.gitLayout, tmpDir: p.tmpDir, excludesFile: p.excludesFile })
    return { own, env: { ...ctx.base, ...own, ...p.vars } }
  }

  /** Each config.worktree of the layout: there or not, its size and mode (bubblewrap may leave a mount-point file). */
  const worktreeConfigFiles = (layout) =>
    layout.worktreeConfigs.map((f) => {
      const st = statSync(f, { throwIfNoEntry: false })
      return { path: f, exists: Boolean(st), size: st?.size ?? null, mode: st ? (st.mode & 0o777).toString(8) : null }
    })

  async function codexSet(set) {
    const shipped = !set.common
    const probes = probesFor(PLATFORM, set.layout).filter((x) => shipped || COMMON_CASE_PROBES.includes(x.id))
    const pp = await prepare(`${set.name}-plain`, set.layout, {}, { shipped })
    const plain = runProbes(plainWrap, { cwd: pp.cwd, env: codexEnvOf(pp).env, probes, timeoutMs: PROBE_MS })
    const p = await prepare(set.name, set.layout, {}, { shipped })
    const denied = codexDenied(PLATFORM, ctx.base, ctx.home, ctx.hostDir, ctx.appKeyFile)
    const args = codexSetArgs({ platform: PLATFORM, layout: p.gitLayout, denied, variant: set.variant })
    const { own, env } = codexEnvOf(p)
    const wrap = (line) => ({ file: 'codex', args: ['sandbox', ...args, '--', ...shellArgv(PLATFORM, line)] })
    const record = { layout: set.layout, cwd: p.cwd, gitLayout: p.gitLayout, sibling: p.sibling, worktreeConfig: p.worktreeConfig, gitFiles: p.gitFiles, args, env: own, denied }
    if (set.common) {
      record.filesBefore = worktreeConfigFiles(p.gitLayout)
      record.sanity = runProbes(wrap, { cwd: p.cwd, env, probes: [{ id: 'sanity', line: sanityLine(PLATFORM) }], timeoutMs: PROBE_MS })[0]
    }
    const sandboxed = runSet(wrap, { cwd: p.cwd, env, probes, timeoutMs: PROBE_MS, sanity: sanityLine(PLATFORM) })
    if (set.common) record.filesAfter = worktreeConfigFiles(p.gitLayout)
    return { ...record, plain, sandboxed, verdicts: verdicts(plain, sandboxed) }
  }

  async function appServerSet(set) {
    const probes = probesFor(PLATFORM, set.layout)
    const pp = await prepare(`${set.name}-plain`, set.layout)
    const plain = runProbes(plainWrap, { cwd: pp.cwd, env: codexEnvOf(pp).env, probes, timeoutMs: PROBE_MS })
    const p = await prepare(set.name, set.layout)
    const denied = codexDenied(PLATFORM, ctx.base, ctx.home, ctx.hostDir, ctx.appKeyFile)
    const args = codexSetArgs({ platform: PLATFORM, layout: p.gitLayout, denied })
    const profile = profileNameOf(args)
    const { own, env } = codexEnvOf(p)
    const record = {
      layout: set.layout,
      cwd: p.cwd,
      gitLayout: p.gitLayout,
      sibling: p.sibling,
      worktreeConfig: p.worktreeConfig,
      gitFiles: p.gitFiles,
      args: ['app-server', ...args],
      env: own,
      denied,
      profile,
      permissionProfileParam: Boolean(set.profileParam)
    }
    const server = startAppServer({ file: 'codex', args: ['app-server', ...args], cwd: p.cwd, env })
    try {
      record.initialize = clip(await server.request('initialize', initializeParams('s2-measure'), 60_000))
      server.notify('initialized', {})
      record.threadStart = threadStartRecord(await server.request('thread/start', s2ThreadStart(p.cwd, profile), 60_000))
      const exec = async (probe) =>
        execResult(
          probe.id,
          await server.request('command/exec', execParams({ platform: PLATFORM, line: probe.line, cwd: p.cwd, profile: set.profileParam ? profile : null, timeoutMs: PROBE_MS }), PROBE_MS + 15_000)
        )
      // As runSet does: a server that cannot run a command at all reads as refused, not as every probe denied
      const sane = await exec({ id: 'sanity', line: sanityLine(PLATFORM) })
      record.sanity = sane
      record.sandboxed = []
      for (const probe of probes)
        record.sandboxed.push(sane.ok ? await exec(probe) : { id: probe.id, code: sane.code, ok: false, timedOut: false, missing: false, refused: true, out: sane.out })
    } finally {
      record.exit = await server.stop()
      record.stderr = server.stderr().slice(-2000)
      record.notifications = [...new Set(server.notifications())]
    }
    record.plain = plain
    record.verdicts = verdicts(plain, record.sandboxed)
    return record
  }

  /** A node process listening where the Host listens (src/host/address.ts), for the macOS socket set. */
  function hostSocket() {
    const { address, dirToPrepare } = hostAddress({ profileDir: path.join(ctx.scratch, 'host-profile'), platform: PLATFORM, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
    mkdirSync(dirToPrepare, { recursive: true, mode: 0o700 })
    const child = spawn(process.execPath, ['-e', "require('net').createServer((c) => c.end('ok')).listen(process.argv[1], () => console.log('ready'))", address], {
      stdio: ['ignore', 'pipe', 'inherit']
    })
    return new Promise((resolve, reject) => {
      child.stdout.once('data', () =>
        resolve({
          path: address,
          stop: () => {
            child.kill()
            rmSync(dirToPrepare, { recursive: true, force: true })
          }
        })
      )
      child.once('error', reject)
      // A listen that fails ends the process before it says ready; without this the set would wait for its timeout
      child.once('exit', (code) => reject(new Error(`the socket server at ${address} exited (${code}) before listening`)))
    })
  }

  async function srtSet(set) {
    // A `.claude` folder in the worktree, as a Claude Code project has: srt then protects `.claude/commands` and
    // `.claude/agents` in it, which are missing there
    const files = set.exclude ? { '.claude/settings.json': '{}\n' } : {}
    const probes = [...probesFor(PLATFORM, set.layout), ...(set.exclude ? [GLOBAL_EXCLUDE_PROBE] : []), ...(set.socket ? [SOCKET_PROBE] : [])]
    const record = { layout: set.layout }
    const extra = {}
    if (set.exclude) {
      const configured = sh(['git', 'config', '--global', '--get', 'core.excludesFile'], { env: ctx.homeEnv }).out.trim() || null
      const globalFile = globalExcludesPath(configured, ctx.homeEnv, ctx.home)
      const file = path.join(ctx.scratch, `excludes-${set.name}`)
      writeFileSync(file, excludesText(existsSync(globalFile) ? readFileSync(globalFile, 'utf8') : '', excludePatterns({ directories: set.exclude === 'directories' })))
      Object.assign(extra, excludesEnv(file))
      record.excludes = { globalFile, file, text: readFileSync(file, 'utf8') }
    }
    const socket = set.socket ? await hostSocket() : null
    if (socket) extra.ASTERA_PROBE_SOCKET = socket.path
    // npm's cache where the builder names it, missing at the start as in a fresh session
    const envOf = (p) => ({ ...ctx.base, npm_config_cache: npmCacheOf(p.tmpDir), ...extra, ...p.vars })
    try {
      const pp = await prepare(`${set.name}-plain`, set.layout, files)
      record.plain = runProbes(plainWrap, { cwd: pp.cwd, env: envOf(pp), probes, timeoutMs: PROBE_MS })
      const p = await prepare(set.name, set.layout, files)
      const npmCache = npmCacheOf(p.tmpDir)
      const claude = claudeSandboxSettings({ platform: PLATFORM, denied: claudeDenied(PLATFORM, ctx.base, ctx.home, ctx.appKeyFile), npmCache, layout: p.gitLayout })
      const commonDir = p.gitLayout?.worktree ? p.gitLayout.commonDir : null
      const settings = srtSettingsOf(claude, { commonDir, ...(socket ? { allowUnixSockets: [socket.path] } : {}) })
      const settingsFile = path.join(ctx.scratch, `srt-settings-${set.name}.json`)
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
      const wrap = (file) => (line) => ({ file: 'srt', args: srtArgv(file, line) })
      const env = envOf(p)
      Object.assign(record, { cwd: p.cwd, gitLayout: p.gitLayout, worktreeConfig: p.worktreeConfig, gitFiles: p.gitFiles, claude: claude.sandbox, settings, env: { npm_config_cache: npmCache, ...extra } })
      record.sandboxed = runSet(wrap(settingsFile), { cwd: p.cwd, env, probes, timeoutMs: PROBE_MS })
      // srt on Linux skips a write path that does not exist (dist/sandbox/linux-sandbox-utils.js): when the install
      // failed, it runs again with the folder made first, as the Host could make it
      record.npmCacheExistedAfter = existsSync(npmCache)
      const npm = record.sandboxed.find((r) => r.id === 'npm-install')
      if (npm && !npm.ok && !npm.refused) {
        mkdirSync(npmCache, { recursive: true })
        record.npmInstallCacheMade = runProbes(wrap(settingsFile), { cwd: p.cwd, env, probes: probes.filter((x) => x.id === 'npm-install'), timeoutMs: PROBE_MS })[0]
      }
      if (socket) {
        // The same settings without the grant: the socket probe there says the grant is what opens the socket
        const controlFile = path.join(ctx.scratch, `srt-settings-${set.name}-no-socket.json`)
        writeFileSync(controlFile, JSON.stringify(srtSettingsOf(claude, { commonDir }), null, 2))
        record.socketWithoutGrant = runSet(wrap(controlFile), { cwd: p.cwd, env, probes: [SOCKET_PROBE], timeoutMs: PROBE_MS })[0]
      }
    } finally {
      socket?.stop()
    }
    record.verdicts = verdicts(record.plain, record.sandboxed)
    return record
  }

  for (const set of S2_SETS) {
    it.skipIf(!s2SetNames(PLATFORM).includes(set.name))(set.name, async () => {
      const run = set.kind === 'codex' ? codexSet : set.kind === 'app-server' ? appServerSet : srtSet
      const r = await run(set)
      result.sets[set.name] = r
      save()
      expect(brokenPlain(r.plain), 'probes that failed with no sandbox: the instrument is broken there, not the sandbox').toEqual([])
    })
  }

  // Design §10 item 1, under the person's own CODEX_HOME (set up, so nothing asks for an administrator): the plan's
  // readiness probe, Codex's setup command's help, the probe with mxc, and Codex's own report of the setup, which reads
  // it without running it and so is safe with a scratch CODEX_HOME too
  it.skipIf(!WIN)('windows readiness, setup --help, mxc and doctor', () => {
    const cwd = path.join(ctx.scratch, 'readiness')
    mkdirSync(cwd, { recursive: true })
    const env = { ...process.env, CODEX_HOME: ctx.codexHome }
    delete env.CODEX_WINDOWS_REGISTERED_CORE
    const scratchHome = path.join(ctx.scratch, 'codex-home-doctor')
    mkdirSync(scratchHome, { recursive: true })
    result.windows = {
      codexHome: ctx.codexHome,
      readiness: readiness(runCodex(readinessArgv('elevated'), { env, cwd })),
      setupHelp: clipped(runCodex(['sandbox', 'setup', '--help'], { env, cwd })),
      mxc: readiness(runCodex(readinessArgv('mxc'), { env, cwd })),
      // Programs in each mode, beside the readiness probe's `echo`: who runs them, and whether one starts at all (found
      // by the first local run: the mxc probe answered ready under codex 0.160.0, which the docs say mxc needs 0.162.0 for)
      programs: Object.fromEntries(
        ['elevated', 'mxc'].map((mode) => [mode, { whoami: clipped(runCodex(whoamiArgv(mode), { env, cwd })), node: clipped(runCodex(nodeVersionArgv(mode), { env, cwd })) }])
      ),
      doctor: doctorReport(runCodex(DOCTOR_ARGV, { env, cwd })),
      doctorScratch: { codexHome: scratchHome, ...doctorReport(runCodex(DOCTOR_ARGV, { env: { ...env, CODEX_HOME: scratchHome }, cwd })) }
    }
    save()
    expect(result.windows.readiness.missing).toBe(false)
  })
})

// Asked of the person first (plan Task 2 Step 3): a Codex home without the sandbox set up may bring up Windows'
// administrator prompt, which waits on the person's screen. Its own results file; nothing else runs with it.
// Declining the prompt is the safe answer, and gives the not-set-up text. Accepting it runs Codex's setup for the
// scratch home, which gives the machine's two sandbox users new passwords and stores them in that home only
// (setup_provisioning/sandbox_users.rs at rust-v0.160.0): every other set-up Codex home, the person's own among them,
// then holds stale ones until its setup runs again.
describe.skipIf(!scratchReadinessEnabled(process.env, process.platform))('S2: Windows readiness with a scratch CODEX_HOME', { timeout: 15 * 60_000 }, () => {
  it('asks the readiness probe in a Codex home that was never set up', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'astera-s2-readiness-'))
    const codexHome = path.join(scratch, 'codex-home')
    const cwd = path.join(scratch, 'cwd')
    mkdirSync(codexHome, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    const env = { ...process.env, CODEX_HOME: codexHome }
    delete env.CODEX_WINDOWS_REGISTERED_CORE
    const out = {
      at: new Date().toISOString(),
      codexHome,
      version: runCodex(['--version'], { env, cwd }).stdout.trim(),
      // Five minutes each, so a person who sees the prompt has time to answer it
      elevated: readiness(runCodex(readinessArgv('elevated'), { env, cwd, timeout: 300_000 })),
      mxc: readiness(runCodex(readinessArgv('mxc'), { env, cwd, timeout: 300_000 })),
      doctor: doctorReport(runCodex(DOCTOR_ARGV, { env, cwd }))
    }
    out.homeAfter = readdirSync(codexHome)
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(path.join(OUT_DIR, 'win32-s2-scratch-readiness.json'), JSON.stringify(out, null, 2))
    process.stdout.write(`elevated: exit ${out.elevated.code}, ready ${out.elevated.ready}; mxc: exit ${out.mxc.code}, ready ${out.mxc.ready}; doctor: ${out.doctor.provisioning}\n`)
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
    } catch (err) {
      process.stdout.write(`could not remove ${scratch}: ${err.message}\n`)
    }
    expect(out.elevated.missing).toBe(false)
  })
})
