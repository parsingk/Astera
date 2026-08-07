/** Picks the type icon for a file or folder.
 *  Pure string logic with no runtime dependency such as node:path — the renderer (web tsconfig)
 *  imports it directly (the same rule as paths.ts, unlike tree.ts which uses node:path).
 *  id is the shape and tone is the colour, kept orthogonal — the same shape is reused in several
 *  colours. */

export const ICON_IDS = [
  'folder', 'folder-open', 'file', 'label',
  'code-braces', 'code-hash', 'code-angle', 'markdown', 'text-lines',
  'gear', 'git', 'container',
  'image', 'video', 'audio', 'archive',
  'database', 'terminal', 'table', 'lock'
] as const

export type IconId = (typeof ICON_IDS)[number]

export type IconTone =
  | 'blue' | 'cyan' | 'green' | 'yellow' | 'orange'
  | 'red' | 'purple' | 'pink' | 'gray' | 'mute'

export interface FileIconSpec {
  id: IconId
  tone: IconTone
  /** Only meaningful when id === 'label'. At most 3 characters. */
  label?: string
  /** Test-file marker — a dot at the icon's bottom right */
  badge?: 'test'
}

const FALLBACK: FileIconSpec = { id: 'file', tone: 'gray' }

const lbl = (label: string, tone: IconTone): FileIconSpec => ({ id: 'label', tone, label })

/** Exact file name (lowercase) -> spec. Takes precedence over the extension. */
const EXACT: Record<string, FileIconSpec> = {
  'package.json': { id: 'code-braces', tone: 'red' },
  'package-lock.json': { id: 'lock', tone: 'gray' },
  'yarn.lock': { id: 'lock', tone: 'gray' },
  'pnpm-lock.yaml': { id: 'lock', tone: 'gray' },
  'cargo.lock': { id: 'lock', tone: 'gray' },
  'poetry.lock': { id: 'lock', tone: 'gray' },
  'composer.lock': { id: 'lock', tone: 'gray' },
  'gemfile.lock': { id: 'lock', tone: 'gray' },
  'uv.lock': { id: 'lock', tone: 'gray' },
  'go.sum': { id: 'lock', tone: 'gray' },
  'go.mod': lbl('GO', 'cyan'),
  '.gitignore': { id: 'git', tone: 'orange' },
  '.gitattributes': { id: 'git', tone: 'orange' },
  '.gitmodules': { id: 'git', tone: 'orange' },
  '.dockerignore': { id: 'container', tone: 'blue' },
  'docker-compose.yml': { id: 'container', tone: 'blue' },
  'docker-compose.yaml': { id: 'container', tone: 'blue' },
  'compose.yml': { id: 'container', tone: 'blue' },
  'compose.yaml': { id: 'container', tone: 'blue' },
  makefile: { id: 'terminal', tone: 'orange' },
  gnumakefile: { id: 'terminal', tone: 'orange' },
  license: { id: 'text-lines', tone: 'yellow' },
  licence: { id: 'text-lines', tone: 'yellow' },
  'license.md': { id: 'text-lines', tone: 'yellow' },
  notice: { id: 'text-lines', tone: 'yellow' },
  '.editorconfig': { id: 'gear', tone: 'gray' },
  '.npmrc': { id: 'gear', tone: 'gray' },
  '.nvmrc': { id: 'gear', tone: 'gray' },
  '.prettierrc': { id: 'gear', tone: 'gray' },
  '.eslintrc': { id: 'gear', tone: 'gray' }
}

/** Prefix (plus optional suffix) rules — checked after exact names, before extensions. */
const PREFIX: Array<{ start: string; end?: string; spec: FileIconSpec }> = [
  { start: 'tsconfig', end: '.json', spec: { id: 'code-braces', tone: 'blue' } },
  { start: '.env', spec: { id: 'gear', tone: 'yellow' } },
  { start: 'dockerfile', spec: { id: 'container', tone: 'blue' } }
]

/** Composite extensions — take precedence over single extensions. */
const COMPOSITE: Array<{ end: string; spec: FileIconSpec }> = [
  { end: '.d.ts', spec: lbl('TS', 'purple') },
  { end: '.tar.gz', spec: { id: 'archive', tone: 'orange' } },
  { end: '.tar.bz2', spec: { id: 'archive', tone: 'orange' } }
]

const TEST_FILE = /\.(test|spec)\.[^.]+$/

/** Extension (lowercase, no dot) -> spec */
const EXT: Record<string, FileIconSpec> = {
  // Languages — the label shape plus the label characters
  ts: lbl('TS', 'blue'), mts: lbl('TS', 'blue'), cts: lbl('TS', 'blue'),
  tsx: lbl('TS', 'cyan'),
  js: lbl('JS', 'yellow'), mjs: lbl('JS', 'yellow'), cjs: lbl('JS', 'yellow'),
  jsx: lbl('JS', 'orange'),
  py: lbl('PY', 'green'), pyi: lbl('PY', 'green'),
  go: lbl('GO', 'cyan'),
  rs: lbl('RS', 'orange'),
  java: lbl('JV', 'red'),
  kt: lbl('KT', 'purple'), kts: lbl('KT', 'purple'),
  cs: lbl('C#', 'purple'),
  c: lbl('C', 'blue'),
  h: lbl('H', 'gray'),
  cpp: lbl('C+', 'blue'), cc: lbl('C+', 'blue'), cxx: lbl('C+', 'blue'),
  hpp: lbl('H+', 'gray'), hh: lbl('H+', 'gray'),
  php: lbl('PH', 'purple'),
  rb: lbl('RB', 'red'),
  lua: lbl('LU', 'blue'),
  dart: lbl('DT', 'cyan'),
  swift: lbl('SW', 'orange'),
  graphql: lbl('GQ', 'pink'), gql: lbl('GQ', 'pink'),
  proto: lbl('PB', 'gray'),
  ipynb: lbl('NB', 'orange'),
  pdf: lbl('PDF', 'red'),
  docx: lbl('DOC', 'blue'), doc: lbl('DOC', 'blue'),
  pptx: lbl('PPT', 'orange'), ppt: lbl('PPT', 'orange'),

  // Symbol glyphs
  json: { id: 'code-braces', tone: 'yellow' },
  jsonc: { id: 'code-braces', tone: 'yellow' },
  json5: { id: 'code-braces', tone: 'yellow' },
  css: { id: 'code-hash', tone: 'cyan' },
  scss: { id: 'code-hash', tone: 'pink' },
  sass: { id: 'code-hash', tone: 'pink' },
  less: { id: 'code-hash', tone: 'blue' },
  html: { id: 'code-angle', tone: 'orange' },
  htm: { id: 'code-angle', tone: 'orange' },
  xml: { id: 'code-angle', tone: 'gray' },
  xsd: { id: 'code-angle', tone: 'gray' },
  plist: { id: 'code-angle', tone: 'gray' },
  vue: { id: 'code-angle', tone: 'green' },
  svelte: { id: 'code-angle', tone: 'orange' },
  astro: { id: 'code-angle', tone: 'purple' },
  md: { id: 'markdown', tone: 'cyan' },
  markdown: { id: 'markdown', tone: 'cyan' },
  mdx: { id: 'markdown', tone: 'purple' },
  txt: { id: 'text-lines', tone: 'gray' },
  log: { id: 'text-lines', tone: 'gray' },
  rst: { id: 'text-lines', tone: 'gray' },
  adoc: { id: 'text-lines', tone: 'gray' },
  yml: { id: 'gear', tone: 'purple' },
  yaml: { id: 'gear', tone: 'purple' },
  toml: { id: 'gear', tone: 'gray' },
  ini: { id: 'gear', tone: 'gray' },
  cfg: { id: 'gear', tone: 'gray' },
  conf: { id: 'gear', tone: 'gray' },
  properties: { id: 'gear', tone: 'gray' },

  // Dedicated silhouettes
  png: { id: 'image', tone: 'purple' }, jpg: { id: 'image', tone: 'purple' },
  jpeg: { id: 'image', tone: 'purple' }, gif: { id: 'image', tone: 'purple' },
  webp: { id: 'image', tone: 'purple' }, bmp: { id: 'image', tone: 'purple' },
  ico: { id: 'image', tone: 'purple' }, avif: { id: 'image', tone: 'purple' },
  tiff: { id: 'image', tone: 'purple' }, svg: { id: 'image', tone: 'purple' },
  mp4: { id: 'video', tone: 'pink' }, mkv: { id: 'video', tone: 'pink' },
  mov: { id: 'video', tone: 'pink' }, webm: { id: 'video', tone: 'pink' },
  avi: { id: 'video', tone: 'pink' }, m4v: { id: 'video', tone: 'pink' },
  mp3: { id: 'audio', tone: 'pink' }, wav: { id: 'audio', tone: 'pink' },
  flac: { id: 'audio', tone: 'pink' }, ogg: { id: 'audio', tone: 'pink' },
  m4a: { id: 'audio', tone: 'pink' }, aac: { id: 'audio', tone: 'pink' },
  zip: { id: 'archive', tone: 'orange' }, tar: { id: 'archive', tone: 'orange' },
  gz: { id: 'archive', tone: 'orange' }, tgz: { id: 'archive', tone: 'orange' },
  '7z': { id: 'archive', tone: 'orange' }, rar: { id: 'archive', tone: 'orange' },
  bz2: { id: 'archive', tone: 'orange' }, xz: { id: 'archive', tone: 'orange' },
  sql: { id: 'database', tone: 'orange' }, sqlite: { id: 'database', tone: 'orange' },
  sqlite3: { id: 'database', tone: 'orange' }, db: { id: 'database', tone: 'orange' },
  sh: { id: 'terminal', tone: 'green' }, bash: { id: 'terminal', tone: 'green' },
  zsh: { id: 'terminal', tone: 'green' }, fish: { id: 'terminal', tone: 'green' },
  ps1: { id: 'terminal', tone: 'green' }, psm1: { id: 'terminal', tone: 'green' },
  bat: { id: 'terminal', tone: 'green' }, cmd: { id: 'terminal', tone: 'green' },
  csv: { id: 'table', tone: 'green' }, tsv: { id: 'table', tone: 'green' },
  xlsx: { id: 'table', tone: 'green' }, xls: { id: 'table', tone: 'green' },
  ods: { id: 'table', tone: 'green' },
  lock: { id: 'lock', tone: 'gray' }
}

/** Looks up only the own keys of an object-literal table — this stops the names `constructor` and
 *  `__proto__` from pulling in inherited values (the Object constructor, Object.prototype).
 *  Lowercasing already means `toString`, `valueOf` and the like never get here, but the defence is
 *  kept in one place. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/** Extracts the extension — the leading dot is skipped so `.eslintrc` is not mistaken for one. */
function extOf(lower: string): string {
  const body = lower.startsWith('.') ? lower.slice(1) : lower
  const i = body.lastIndexOf('.')
  return i < 0 ? '' : body.slice(i + 1)
}

export function resolveFileIcon(name: string): FileIconSpec {
  const lower = name.toLowerCase()

  const exact = own(EXACT, lower)
  if (exact) return exact

  for (const rule of PREFIX) {
    if (!lower.startsWith(rule.start)) continue
    // What follows the prefix must be the end of the name or a `.` — matching on the letters alone
    // would drag in `.envrc` and `dockerfile-notes.md`
    const next = lower[rule.start.length]
    if (next !== undefined && next !== '.') continue
    if (rule.end && !lower.endsWith(rule.end)) continue
    return rule.spec
  }

  for (const rule of COMPOSITE) {
    if (lower.endsWith(rule.end)) return rule.spec
  }

  const base = own(EXT, extOf(lower)) ?? FALLBACK
  // Table specs are shared objects — always copy before attaching a badge.
  return TEST_FILE.test(lower) ? { ...base, badge: 'test' } : base
}

/** Every spec the mapping tables can emit — for the completeness test only. */
export function listMappedSpecs(): FileIconSpec[] {
  return [
    ...Object.values(EXT),
    ...Object.values(EXACT),
    ...PREFIX.map((r) => r.spec),
    ...COMPOSITE.map((r) => r.spec)
  ]
}

/** Special folder name (lowercase) -> tone. There are only two shapes, open and closed; only the colour varies. */
const FOLDER_TONE: Record<string, IconTone> = {
  // Source
  src: 'blue', lib: 'blue', app: 'blue', source: 'blue',
  // Tests
  test: 'green', tests: 'green', __tests__: 'green', spec: 'green', specs: 'green', e2e: 'green',
  // Docs
  docs: 'cyan', doc: 'cyan',
  // Assets
  assets: 'purple', public: 'purple', static: 'purple', images: 'purple', img: 'purple',
  media: 'purple', fonts: 'purple',
  // Config (pink, so that VCS keeps orange)
  config: 'pink', configs: 'pink', '.config': 'pink', settings: 'pink',
  // Scripts
  scripts: 'yellow', bin: 'yellow', tools: 'yellow',
  // VCS
  '.git': 'orange', '.github': 'orange', '.gitlab': 'orange',
  // Dependencies
  node_modules: 'mute', vendor: 'mute', '.venv': 'mute', venv: 'mute', 'site-packages': 'mute',
  // Build output
  dist: 'mute', build: 'mute', out: 'mute', target: 'mute',
  '.next': 'mute', '.nuxt': 'mute', '.svelte-kit': 'mute',
  // Caches
  '.cache': 'mute', '.turbo': 'mute', '.gradle': 'mute',
  __pycache__: 'mute', '.pytest_cache': 'mute', '.mypy_cache': 'mute'
}

export function resolveFolderIcon(name: string, open: boolean): FileIconSpec {
  return {
    id: open ? 'folder-open' : 'folder',
    tone: own(FOLDER_TONE, name.toLowerCase()) ?? 'gray'
  }
}
