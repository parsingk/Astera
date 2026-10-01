// The MCP access setting from app-settings.json, read by the Host on every MCP call (MCP design M5).
import type { McpAccess } from '../types'
import { readAppSettingsObject } from './settingsObject'

/** The store's narrowing, shared with the Host's read so the two cannot differ: the two narrower
 *  values are kept, and anything else, a missing key included, is the default (M6). */
export function mcpAccessOf(value: unknown): McpAccess {
  return value === 'off' || value === 'read' ? value : 'control'
}

/** Missing file: 'control'. Unreadable file: throws, because it may have said 'off' (the
 *  readAgentPermissionMode rule). */
export async function readMcpAccess(filePath: string): Promise<McpAccess> {
  const parsed = await readAppSettingsObject(filePath)
  return mcpAccessOf(parsed?.mcpAccess)
}
