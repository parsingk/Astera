// This machine's shared extensions as the Runtime report gives them (remote governance design §5.2, §5.3): each entry's
// id, kind, name, switch and providers, a file kind's comparison hash, an MCP server's secret names and its Gateway state.
// Built field by field, never spread from the entry, so an MCP launch definition (command, args, cwd, url, env values),
// where it was imported from and the Gateway's last error never reach a controller.
import { readExtensionRegistry } from '../extensions/registry'
import { compareHashOf } from '../extensions/compareHash'
import type { UpstreamState } from '../../host/gateway/upstream'
import type { ReportExtension } from './report'

/** Every registry entry as the report holds it. A registry that cannot be read throws, as readExtensionRegistry does: an
 *  empty list would tell a controller this machine shares nothing. */
export async function localReportExtensions(profileDir: string, gateway?: readonly UpstreamState[]): Promise<ReportExtension[]> {
  const { entries } = await readExtensionRegistry(profileDir)
  return Promise.all(
    entries.map(async (e): Promise<ReportExtension> => {
      const out: ReportExtension = { id: e.id, kind: e.kind, name: e.name, enabled: e.enabled, providers: [...e.providers] }
      if (e.kind === 'mcp') {
        out.secretNames = Object.entries(e.env).flatMap(([name, v]) => ('secret' in v ? [name] : []))
        // The Gateway runs stdio servers only; its lastError can quote a command line or a path (§5.3), so only the state
        const held = e.transport === 'stdio' ? gateway?.find((s) => s.serverId === e.id) : undefined
        if (held) out.gateway = held.state
        return out
      }
      // A copy that cannot be read leaves the hash out: a controller then shows "cannot compare", not "different"
      const hash = await compareHashOf(profileDir, e).catch(() => undefined)
      if (hash !== undefined) out.compareHash = hash
      return out
    })
  )
}
