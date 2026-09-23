// The permission mode from app-settings.json, read by a process that is not the app (the Host).
import { promises as fs } from 'node:fs'
import type { AgentPermissionMode } from '../types'
import { settingsObjectOf } from './settingsObject'

/** The store's own narrowing: only the explicit 'manual' turns the bypass off. */
export function agentPermissionModeOf(value: unknown): AgentPermissionMode {
  return value === 'manual' ? 'manual' : 'yolo'
}

/** Read only. No file, an unreadable file or an unparseable file all answer 'yolo' — the store's
 *  default and what it recovers to (appSettingsStore), and D12's choice: 'manual' would stop a
 *  headless worker at its first command with nobody to answer.
 *
 *  Not AppSettingsStore.load: on a file it cannot parse, load copies it to `.bak`, and the app is the
 *  file's only writer. */
export async function readAgentPermissionMode(filePath: string): Promise<AgentPermissionMode> {
  try {
    return agentPermissionModeOf(settingsObjectOf(await fs.readFile(filePath, 'utf8')).agentPermissionMode)
  } catch {
    return 'yolo'
  }
}
