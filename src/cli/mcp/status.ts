// `astera mcp status` (spec §40): whether `astera mcp serve` would work on this profile, for a person
// or a script to run before registering it with a client. It only looks: no Host is started, and a
// Host that answers is asked nothing past its hello. Its shape and its codes follow `host status`
// (cli/host.ts): the body on success, and the same report in `error.details` on a failure.
import os from 'node:os'
import path from 'node:path'
import { connectHost } from '../../core/host/connect'
import { HOST_FEATURE_MCP, HOST_PROTOCOL } from '../../core/host/protocol'
import { readMcpAccess } from '../../core/settings/mcpAccess'
import type { McpAccess } from '../../core/types'
import {
  cliHostTarget,
  impostorError,
  logToStderr,
  otherProtocolHost,
  siblingHostError,
  type HostCommandResult
} from '../host'
import { TOOLS } from './tools'

export async function mcpStatus(a: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  version: string
}): Promise<HostCommandResult> {
  const { address, profileDir } = cliHostTarget({ env: a.env, platform: a.platform, home: a.home })

  // The setting the Host reads on every MCP call, read the same way. A file it cannot read is null,
  // not a guess: the Host refuses every MCP call until the file is repaired.
  let access: McpAccess | null
  let warning: string | undefined
  try {
    access = await readMcpAccess(path.join(profileDir, 'app-settings.json'))
  } catch (err) {
    access = null
    warning = `${err instanceof Error ? err.message : String(err)}; until then the Host fails every MCP call`
  }

  const conn = await connectHost({ address, profileDir, app: a.version, log: logToStderr })
  if ('error' in conn && conn.error === 'impostor') return { ok: false, error: impostorError(address, profileDir) }
  const host =
    'error' in conn
      ? { running: false, mcp: false }
      : { running: true, version: conn.hello.host, protocol: HOST_PROTOCOL, mcp: conn.hello.features.includes(HOST_FEATURE_MCP) }
  if (!('error' in conn)) conn.close()
  const body: Record<string, unknown> = {
    cliVersion: a.version,
    transport: 'stdio',
    host,
    access,
    tools: TOOLS.length,
    ...(warning !== undefined ? { warning } : {})
  }

  if (!host.running) {
    // A Host of another protocol on this profile is 9, as `host status` says (cli/host.ts).
    const found = await otherProtocolHost({ profileDir, platform: a.platform, tmpDir: os.tmpdir() })
    if (found) return { ok: false, error: siblingHostError({ found, cliProtocol: HOST_PROTOCOL }) }
    return {
      ok: false,
      error: {
        code: 'HOST_NOT_RUNNING',
        message: `no Host is running for the profile ${profileDir}; \`astera mcp serve\` starts one when a client launches it, or run \`astera host start\``,
        details: body
      }
    }
  }
  if (!host.mcp)
    return {
      ok: false,
      error: {
        code: 'VERSION_MISMATCH',
        message: `the Host (${host.version}) does not serve MCP clients: it comes from an older Astera. Stop it with \`astera host stop\` and start this one with \`astera host start\``,
        details: body
      }
    }
  return { ok: true, body }
}
