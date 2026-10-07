// What a paired Runtime offers a controller at all (remote runtime design §3.4, X1-14): exactly what its controller
// gate lets through, at either permission. The CLI and MCP refuse everything else with RUNTIME_CAPABILITY_MISSING
// before any local call or file read, so `--runtime` never falls back to this machine.
import { CONTROLLER_CONTROL_COMMANDS, CONTROLLER_READ_COMMANDS } from '../host/controllerGate'

const OFFERED: ReadonlySet<string> = new Set<string>([...CONTROLLER_READ_COMMANDS, ...CONTROLLER_CONTROL_COMMANDS])
const CONTROL: ReadonlySet<string> = new Set<string>(CONTROLLER_CONTROL_COMMANDS)

export const remoteTarget = (cmd: string): 'yes' | 'no' => (OFFERED.has(cmd) ? 'yes' : 'no')

/** A command that changes something on the Runtime: it carries a request id, so a resend never runs it twice (§3.9). */
export const remoteMutation = (cmd: string): boolean => CONTROL.has(cmd)
