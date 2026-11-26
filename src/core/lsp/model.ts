// What Astera keeps of language servers (Phase 3 Part 3), shared by the Host, main and the renderer: types only, so the
// renderer can name them (listed in tsconfig.web).

/** A server Astera installs: TypeScript 7's own LSP, typescript-language-server with TypeScript 5.9.3 for projects below
 *  TypeScript 6, and pyright. */
export type LspServerId = 'typescript' | 'typescript5' | 'python'
export type LspLanguage = 'typescript' | 'python'

/** A file open in the editor, with the project root it was opened under. */
export interface LspOpenFile {
  path: string
  root: string
}

/** One problem a server reported: 1-based lines, columns in UTF-16 code units as the editor and LSP count them. */
export interface LspProblem {
  line: number
  column: number
  endLine: number
  endColumn: number
  severity: 'error' | 'warning' | 'info'
  message: string
  code?: string
}

/** A file's problems as its server last reported them. */
export interface LspFileDiagnostics {
  root: string
  path: string
  server: LspServerId
  producedAt: string
  problems: LspProblem[]
}

/** Why a server's status carries a word for the person: the project seems to use an older TypeScript, or the
 *  TypeScript 5 server would check it as its own TypeScript does. */
export type LspNote = 'older-typescript' | 'typescript5-not-installed'

/** Why a server is stopped or failed, in a word the settings screen says in the person's language: not installed,
 *  stopped to make room for another (at most four run), crashed three times, refused for another reason. `reason`
 *  carries the details. */
export type LspWhy = 'not-installed' | 'room' | 'crashed' | 'refused'

export interface LspServerStatus {
  server: LspServerId
  root: string
  status: 'starting' | 'running' | 'stopped' | 'failed'
  why?: LspWhy
  reason?: string
  pid?: number
  notes?: LspNote[]
}

/** A package Astera fetches for a server, pinned: exact version, the tarball's sha512 (`npm view <spec> dist.integrity`),
 *  its licence and unpacked size. */
export interface PinnedPackage {
  name: string
  version: string
  integrity: string
  licence: string
  bytes: number
}

/** `folder`: where its packages go (`<profile>/language-servers`), which the install confirmation names. */
export interface LspInstalled {
  server: LspServerId
  available: boolean
  installed: boolean
  packages: PinnedPackage[]
  folder: string
}

/** The "언어 서버" settings: each language on or off, a path that replaces Astera's install, pyright's interpreter, and
 *  the projects whose virtual environment the person allowed. */
export interface LanguageServerSettings {
  typescript: { enabled: boolean; path?: string }
  python: { enabled: boolean; path?: string; interpreter?: string; venvProjects: string[] }
}
