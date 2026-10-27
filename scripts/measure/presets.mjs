// The Credentials list's login presets measured against their own tools (enforce and sandbox design §8): for each, a fake
// config where the tool looks by default, the tool's own command that shows it read it, and the same command once the
// preset applies (its variables taken away, its locations pointed at an empty folder or file). A `.mjs` cannot import
// src/core/credentials/presets.ts, so `remove` and `redirect` are copied here; presets.test.mjs pins them equal.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
- name: astera-probe
  cluster:
    server: https://127.0.0.1:6443
contexts:
- name: astera-probe
  context:
    cluster: astera-probe
    user: astera-probe
current-context: astera-probe
users:
- name: astera-probe
  user:
    token: astera-probe-fake
`

export const PRESET_PROBES = {
  gh: {
    remove: ['GH_TOKEN', 'GITHUB_TOKEN'],
    redirect: { GH_CONFIG_DIR: 'empty-dir' },
    files: { '.config/gh/hosts.yml': 'github.com:\n    oauth_token: gho_astera_probe_fake\n    user: astera-probe\n    git_protocol: https\n' },
    argv: ['gh', 'auth', 'status', '--hostname', 'github.com'],
    marker: 'astera-probe',
    // The job's own token, set for the run before: gh names it by its variable
    alsoRead: ['GH_TOKEN']
  },
  aws: {
    remove: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE'],
    redirect: { AWS_CONFIG_FILE: 'empty-file', AWS_SHARED_CREDENTIALS_FILE: 'empty-file' },
    files: { '.aws/credentials': '[default]\naws_access_key_id = AKIAASTERAPROBE00001\naws_secret_access_key = astera-probe-fake\n' },
    argv: ['aws', 'configure', 'get', 'aws_access_key_id'],
    marker: 'AKIAASTERAPROBE00001'
  },
  gcloud: {
    remove: ['GOOGLE_APPLICATION_CREDENTIALS'],
    redirect: { CLOUDSDK_CONFIG: 'empty-dir' },
    files: {
      '.config/gcloud/configurations/config_default': '[core]\naccount = astera-probe@example.com\n',
      '.config/gcloud/active_config': 'default'
    },
    argv: ['gcloud', 'config', 'get-value', 'account'],
    marker: 'astera-probe@example.com'
  },
  npm: {
    remove: ['NPM_TOKEN'],
    redirect: { NPM_CONFIG_USERCONFIG: 'empty-file' },
    files: { '.npmrc': 'init-author-name=astera-probe\n' },
    argv: ['npm', 'config', 'get', 'init-author-name'],
    marker: 'astera-probe'
  },
  docker: {
    remove: [],
    redirect: { DOCKER_CONFIG: 'empty-dir' },
    files: { '.docker/config.json': '{"currentContext":"astera-probe"}\n' },
    argv: ['docker', 'context', 'show'],
    marker: 'astera-probe'
  },
  kubectl: {
    remove: [],
    redirect: { KUBECONFIG: 'empty-file' },
    files: { '.kube/config': KUBECONFIG },
    argv: ['kubectl', 'config', 'current-context'],
    marker: 'astera-probe'
  }
}

/** `base` as the preset leaves it for a session: its variables taken away, each redirected one pointed at its own path
 *  under `scratch`. `make` lists what to create there; nothing is created here. */
export function presetEnv(base, probe, scratch) {
  const env = { ...base }
  for (const name of probe.remove) delete env[name]
  const make = []
  for (const [name, kind] of Object.entries(probe.redirect)) {
    env[name] = path.join(scratch, name.toLowerCase())
    make.push({ path: env[name], kind: kind === 'empty-dir' ? 'dir' : 'file' })
  }
  return { env, make }
}

/** Whether the preset hides the tool's login: read before it applies, not after. `alsoRead`: other words that show the
 *  tool read a login. */
export function presetVerdict(before, after, marker, alsoRead = []) {
  if (before.missing || after.missing) return 'missing'
  const read = (out) => [marker, ...alsoRead].some((m) => out.includes(m))
  if (!read(before.out)) return 'not-read'
  return read(after.out) ? 'does-not-hide' : 'hides'
}

const OUT_MAX = 300

/** Writes each preset's fake files under `home`, runs its command before and after the preset applies, and says what it
 *  found. `run(argv, env)` → `{ missing, out }`. */
export function measurePresets(home, scratch, run, base = process.env) {
  return Object.entries(PRESET_PROBES).map(([id, probe]) => {
    for (const [rel, text] of Object.entries(probe.files)) {
      const file = path.join(home, rel)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
    const before = run(probe.argv, { ...base, HOME: home })
    const { env, make } = presetEnv({ ...base, HOME: home }, probe, path.join(scratch, id))
    for (const m of make) {
      if (m.kind === 'dir') mkdirSync(m.path, { recursive: true })
      else {
        mkdirSync(path.dirname(m.path), { recursive: true })
        writeFileSync(m.path, '')
      }
    }
    const after = run(probe.argv, env)
    return {
      id,
      verdict: presetVerdict(before, after, probe.marker, probe.alsoRead),
      before: before.out.slice(0, OUT_MAX),
      after: after.out.slice(0, OUT_MAX)
    }
  })
}
