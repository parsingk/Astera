import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Phase 3 Part 3: how the Host runs the language servers. index.ts and orch.ts start the whole Host, so their wiring is
// pinned by its text; the manager, the sessions and the commands are tested on their own.
const host = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const index = readFileSync(path.join(host, 'index.ts'), 'utf8')
const orch = readFileSync(path.join(host, 'orch.ts'), 'utf8')
const server = readFileSync(path.join(host, 'server.ts'), 'utf8')

describe('the language servers in the Host', () => {
  // Final review C2 and I3: a settings change refreshes after the sync; a deletion on disk rides with the saves
  it('takes the open set and the saves from a greeted app only', () => {
    expect(index).toMatch(
      /if \(m\.t === 'lsp-sync'\) \{\s*if \(from\.greeted && from\.role === 'app'\) \{\s*lspSyncSocket = from\.socket\s*lspManager\.sync\(m\.open, m\.interpreters\)\s*if \(m\.refresh\) lspManager\.refresh\(\)\s*\}\s*return true\s*\}/
    )
    expect(index).toMatch(/if \(m\.t === 'lsp-saved'\) \{\s*if \(from\.greeted && from\.role === 'app'\) lspManager\.saved\(m\.paths, m\.deleted\)\s*return true\s*\}/)
  })

  // Final review M6: only the connection that sent the open set takes it away when it goes
  it('closes everything when the app’s syncing connection goes, and stops every server when the Host leaves', () => {
    expect(index).toMatch(/if \(from\.role === 'app' && from\.socket === lspSyncSocket\) \{\s*lspSyncSocket = null\s*lspManager\.appGone\(\)\s*\}/)
    expect(index).toMatch(/disposeWithin\(lspManager\.stopAll\(\), LSP_STOP_CAP_MS,/)
  })

  it('pushes problems and server states to the apps', () => {
    expect(index).toMatch(/emit: \(files\) => server\.broadcast\(\{ t: 'lsp-diagnostics', files \}\)/)
    expect(index).toMatch(/state: \(servers\) => server\.broadcast\(\{ t: 'lsp-state', servers \}\)/)
    expect(server).toMatch(/'lsp-diagnostics': 'app'/)
    expect(server).toMatch(/'lsp-state': 'app'/)
  })

  it('answers lsp-* below the receipt line, refusing the changes to an agent’s shell', () => {
    expect(orch).toMatch(/if \(LSP_COMMANDS\.has\(cmd\)\) \{/)
    expect(orch).toMatch(/lspCommand\(\{[\s\S]{0,200}\.\.\.\(agentShell\(from, sessionId\) \? \{ agentRefusal: AGENT_REFUSAL\(cmd\) \} : \{\}\)/)
  })
})
