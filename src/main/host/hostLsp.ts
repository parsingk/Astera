// The app's view of the Host's language servers (Phase 3 Part 3). The window says which files are open (`setOpen`, whole
// each time) and which were saved; this sends them to a Host that announced `lsp`, with the Python interpreter for each
// root that has a Python file open, and sends the whole set again after every handshake. The Host pushes each file's
// problems and every server's state; this keeps the latest per file for the Problems list and forgets them all when the
// Host goes. It never throws, the hostDriver.ts rule. ipc.ts only wires it.
import { isUnder } from '../../core/context/contextRef'
import { foldPathCase } from '../../core/files/paths'
import { HOST_FEATURE_LSP, type ClientMessage, type HostMessage } from '../../core/host/protocol'
import { languageOf } from '../../core/lsp/languages'
import type { LanguageServerSettings, LspFileDiagnostics, LspOpenFile, LspServerStatus } from '../../core/lsp/model'
import type { PythonInterpreter } from '../../core/run/python'

export interface HostLspView {
  setOpen(files: LspOpenFile[]): Promise<void>
  saved(paths: string[]): void
  pushed(m: HostMessage): void
  connected(): Promise<void>
  status(): void
  files(project: string): LspFileDiagnostics[]
  servers(): LspServerStatus[]
}

const batch = (p: string): boolean => /\.(?:bat|cmd)$/i.test(p)

/** pyright's interpreter for a root (design §5 Part 3, the person's decision): the project's own virtual environment once
 *  the person allowed it for that project, else the interpreter the person picked, else the first one found outside the
 *  project, else none. A batch file is never one (pyright would run it through a shell). */
export function pickInterpreter(root: string, settings: LanguageServerSettings, found: readonly PythonInterpreter[]): string | null {
  const usable = found.filter((i) => !batch(i.path))
  if (settings.python.venvProjects.some((p) => isUnder(p, root) && isUnder(root, p))) {
    const venv = usable.find((i) => isUnder(root, i.path))
    if (venv) return venv.path
  }
  if (settings.python.interpreter !== undefined && !batch(settings.python.interpreter)) return settings.python.interpreter
  return usable.find((i) => !isUnder(root, i.path))?.path ?? null
}

export function createHostLspView(d: {
  status(): { connected: boolean; features: readonly string[] }
  send(m: ClientMessage): boolean
  interpreterFor(root: string): Promise<string | null>
  /** The Problems list asks again. */
  changed(): void
  stateChanged(servers: LspServerStatus[]): void
  log(m: string): void
}): HostLspView {
  let open: LspOpenFile[] = []
  let asks = 0
  let problems = new Map<string, LspFileDiagnostics>()
  let servers: LspServerStatus[] = []

  const speaks = (): boolean => {
    try {
      const s = d.status()
      return s.connected && s.features.includes(HOST_FEATURE_LSP)
    } catch {
      return false
    }
  }

  const sendOpen = async (): Promise<void> => {
    const mine = ++asks
    if (!speaks()) return
    const files = open
    const interpreters: Record<string, string | null> = {}
    try {
      const roots = new Map<string, string>()
      for (const f of files) if (languageOf(f.path) === 'python') roots.set(foldPathCase(f.root), f.root)
      for (const root of roots.values()) interpreters[root] = await d.interpreterFor(root)
    } catch (e) {
      d.log(`lsp: the interpreters could not be found: ${e instanceof Error ? e.message : String(e)}`)
    }
    // A newer set went out while this one asked: it is the one the Host needs
    if (mine !== asks) return
    d.send({ t: 'lsp-sync', open: files, interpreters })
  }

  return {
    setOpen(files) {
      open = files
      return sendOpen()
    },
    saved(paths) {
      if (paths.length > 0 && speaks()) d.send({ t: 'lsp-saved', paths })
    },
    pushed(m) {
      try {
        if (m.t === 'lsp-diagnostics') {
          for (const f of m.files) {
            const key = `${f.server}|${foldPathCase(f.path)}`
            if (f.problems.length === 0) problems.delete(key)
            else problems.set(key, f)
          }
          d.changed()
        } else if (m.t === 'lsp-state') {
          servers = m.servers
          d.stateChanged(servers)
        }
      } catch (e) {
        d.log(`lsp: a push could not be applied: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    connected: () => sendOpen(),
    status() {
      let connected = false
      try {
        connected = d.status().connected
      } catch {
        // read as gone
      }
      if (connected) return
      const had = problems.size > 0
      problems = new Map()
      if (had) d.changed()
      if (servers.length > 0) {
        servers = []
        d.stateChanged(servers)
      }
    },
    files: (project) => [...problems.values()].filter((f) => isUnder(project, f.path)),
    servers: () => servers
  }
}
