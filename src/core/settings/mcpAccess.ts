// The MCP access setting from app-settings.json, read by the Host on every MCP call (MCP design M5).
import type { McpAccess } from '../types'
import { readAppSettingsObject } from './settingsObject'

/** The store's narrowing, shared with the Host's read so the two cannot differ: the two narrower
 *  values are kept, and anything else, a missing key included, is the default (M6). */
export function mcpAccessOf(value: unknown): McpAccess {
  return value === 'off' || value === 'read' ? value : 'control'
}

/** The same setting for a call to a paired Runtime (remote runtime design §2.8, DC-4): a value that is none of the
 *  three is off, since a controller is default deny; an absent one keeps the default, as the local read does. */
export function mcpAccessForRemote(value: unknown): McpAccess {
  if (value === undefined) return mcpAccessOf(undefined)
  return value === 'off' || value === 'read' || value === 'control' ? value : 'off'
}

/** Missing file: 'control'. Unreadable file: throws, because it may have said 'off' (the
 *  readAgentPermissionMode rule). */
export async function readMcpAccess(filePath: string): Promise<McpAccess> {
  const parsed = await readAppSettingsObject(filePath)
  return mcpAccessOf(parsed?.mcpAccess)
}
