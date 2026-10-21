// The Agent Control Plane's policy mode from app-settings.json (release 1 design §4.8): COMPATIBILITY until the person
// opts into OBSERVE and then ENFORCE (spec §32). Release 1 only reads it; nothing writes it and nothing blocks on it.
import { readAppSettingsObject } from './settingsObject'
import type { PolicyMode } from '../extensions/resolve'

const MODES: readonly PolicyMode[] = ['compatibility', 'observe', 'enforce']

/** A known mode, else compatibility: a missing or unknown value never tightens anything. */
export function controlPlanePolicyModeOf(value: unknown): PolicyMode {
  return MODES.includes(value as PolicyMode) ? (value as PolicyMode) : 'compatibility'
}

/** Missing file: compatibility. Unreadable file: throws (the readMcpAccess rule). */
export async function readControlPlanePolicyMode(filePath: string): Promise<PolicyMode> {
  return controlPlanePolicyModeOf((await readAppSettingsObject(filePath))?.controlPlanePolicyMode)
}
