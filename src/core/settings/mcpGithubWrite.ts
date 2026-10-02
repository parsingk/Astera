// The MCP GitHub-write setting from app-settings.json, read by the Host on every MCP call (MCP P2-B design).
import { readAppSettingsObject } from './settingsObject'

/** The store's narrowing, shared with the Host's read so the two cannot differ: only `true` turns it
 *  on; a missing key or anything else is off. */
export function mcpGithubWriteOf(value: unknown): boolean {
  return value === true
}

/** Missing file: false. Unreadable file: throws, because it may have said false (the readMcpAccess rule). */
export async function readMcpGithubWrite(filePath: string): Promise<boolean> {
  const parsed = await readAppSettingsObject(filePath)
  return mcpGithubWriteOf(parsed?.mcpGithubWrite)
}
