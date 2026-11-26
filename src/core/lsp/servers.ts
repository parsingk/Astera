// The language servers Astera installs, pinned (Phase 3 Part 3; measured 2026-11-26 in
// F:\astera-work\scratch\phase3\measure-lsp.md, the person's option 2): TypeScript 7.0.2's own LSP from its platform
// package, typescript-language-server 6.1.0 with TypeScript 5.9.3 for a project below TypeScript 6, and pyright 1.1.414.
// Each package is the exact version with its tarball's sha512 (`npm view <spec> dist.integrity`), licence and unpacked
// size, which the install confirmation shows and the installer checks.
//
// pyright's interpreter: it is always given an absolute `pythonPath`. Measured, without one it runs a bare `python`,
// which Windows can find in the project folder before PATH; a `.bat`/`.cmd` it would run through a shell. With no
// interpreter to give, the path is one inside Astera's folder that never exists, and the missing-import rules are off, so
// no false problem reaches an agent.
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { LspNote, LspServerId, PinnedPackage } from './model'

export { LSP_SERVERS, languageOf } from './languages'

/** TypeScript 7's native binary, one package per platform and CPU (npm's `os`/`cpu`). */
const TYPESCRIPT7: Readonly<Record<string, Omit<PinnedPackage, 'name' | 'version' | 'licence'>>> = {
  'win32-x64': { integrity: 'sha512-0BQ3HkAHHlKLSp1qRvf3SUhGpGsDuhB/jgFw75guyqbxJqEaS0Cw/VFO8i2nHglJUzQCRtMMR/IBAKE3ETMC4g==', bytes: 28365027 },
  'win32-arm64': { integrity: 'sha512-Gyl1Vy6OsWesLzmq+EP0Fb7b4Nid5232AvcA2SFcdYreldpNtYFFofPjnt62y9hQy7VTaZp65ICJjuAQRaVcIQ==', bytes: 26801387 },
  'linux-x64': { integrity: 'sha512-EYdf2cNg7rgCWJnxCdJ+F3V39O8ihb37eHAu1LK8oAFizgTQbPOK7zHHXbPt8rX24COqODXeI3sIf0fCXG7H/A==', bytes: 27945990 },
  'linux-arm64': { integrity: 'sha512-Qh4eU4/y3yDjnfjjyPYihMj5/ODIlmt+Bzu17OI+fiSRDW57QmU5SiN63exPRNJPKUzcc1INa1NXdrJ+MqHjUQ==', bytes: 26717198 },
  'linux-arm': { integrity: 'sha512-gffT3xPz9sR7j/YJExkyPntrI0P2EP9XbOyWzth2/Gs0RstK+90RBcO0ncXoXy/beYll1SXw846Nf2zdnEz0QQ==', bytes: 26782726 },
  'darwin-x64': { integrity: 'sha512-SZ9xZInqApNlNGc9s0W1VSsktYSOe9cFqNOIqmN1Gs8SmkjKZYFt017G4VwPxASInODuAdbTW7sXiFUf893RgA==', bytes: 28815671 },
  'darwin-arm64': { integrity: 'sha512-gowzar9MwS/aRWp6f3a4KUqzRjAZjOsmGNCM6LcTgXum+dBfgsBVMN+AgvOCCbguXyick6LJhpBszxMebJ8syA==', bytes: 27498111 }
}

const TYPESCRIPT5: readonly PinnedPackage[] = [
  {
    name: 'typescript-language-server',
    version: '6.1.0',
    integrity: 'sha512-/O/dr2CbvDS1W9jKJcBQxk4WagUQ97oBb8k/eq9cOslsbtAuC2BDPpkcULxE2SEZiPIJvVNLeNjLZe9hQl1zCQ==',
    licence: 'Apache-2.0 (MIT parts)',
    bytes: 2456190
  },
  {
    name: 'typescript',
    version: '5.9.3',
    integrity: 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==',
    licence: 'Apache-2.0',
    bytes: 23625066
  }
]

const PYRIGHT: readonly PinnedPackage[] = [
  {
    name: 'pyright',
    version: '1.1.414',
    integrity: 'sha512-FPZZb51jepDX4eP7TEYDeNFtmE3WgwkkEcJpvH3/QmUSsj0EAy3LXu+xB4T/FWDejtsXlCfFr/rbWFjwuwuXww==',
    licence: 'MIT',
    bytes: 19457120
  }
]

/** What Astera fetches for a server on this platform, or null when TypeScript 7 has no package for it. */
export function serverPackages(id: LspServerId, platform: string, arch: string): PinnedPackage[] | null {
  if (id === 'typescript5') return TYPESCRIPT5.map((p) => ({ ...p }))
  if (id === 'python') return PYRIGHT.map((p) => ({ ...p }))
  const key = `${platform}-${arch}`
  const pin = TYPESCRIPT7[key]
  return pin ? [{ name: `@typescript/typescript-${key}`, version: '7.0.2', licence: 'Apache-2.0', ...pin }] : null
}

/** The server that checks a TypeScript/JavaScript project: typescript5 for one below TypeScript 6 when it is installed;
 *  otherwise TypeScript 7, noting when typescript5 would have matched the project's own TypeScript. */
export function typescriptServerFor(major: number | null, installed: ReadonlySet<LspServerId>): { server: LspServerId; notes: LspNote[] } {
  if (major === null || major >= 6) return { server: 'typescript', notes: [] }
  return installed.has('typescript5') ? { server: 'typescript5', notes: [] } : { server: 'typescript', notes: ['typescript5-not-installed'] }
}

/** The `pythonPath` pyright is given: the interpreter when it is an absolute path to no batch file that exists, else a
 *  path inside Astera's folder that never exists, with the missing-import rules off (an interpreter pyright cannot run
 *  would make every import a false problem). */
export function pythonPathFor(interpreter: string | null, profileDir: string, exists: (p: string) => boolean = existsSync): { pythonPath: string; missingImportsOff: boolean } {
  if (interpreter !== null && path.isAbsolute(interpreter) && !/\.(?:bat|cmd)$/i.test(interpreter) && exists(interpreter)) return { pythonPath: interpreter, missingImportsOff: false }
  return { pythonPath: path.join(profileDir, 'language-servers', 'no-python', 'python'), missingImportsOff: true }
}

/** pyright's answer to one `workspace/configuration` item: the `python` section, null for any other. `autoSearchPaths`
 *  is set, since pyright turns it off when an `analysis` object comes without it (measured). */
export function pyrightConfiguration(section: string, p: { pythonPath: string; missingImportsOff: boolean }): unknown {
  if (section !== 'python') return null
  return {
    pythonPath: p.pythonPath,
    analysis: {
      autoSearchPaths: true,
      ...(p.missingImportsOff ? { diagnosticSeverityOverrides: { reportMissingImports: 'none', reportMissingModuleSource: 'none' } } : {})
    }
  }
}
