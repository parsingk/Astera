// The shapes of findings (lifecycle design §4, §6, §7): advice Astera computes from what it already holds, never an
// action. Renderer-safe: no `node:` import, so Settings › Security & Access › Findings and the profile mark read these
// same types the Host computes.
import type { Message } from '../i18n'

export type FindingRule =
  | 'unused-profile' | 'duplicate-profile' | 'broken-reference' | 'failing-profile' | 'unused-mcp' | 'coverage-gap'
  | 'stale-runtime' | 'unmanaged-credential-reference' | 'stale-credential' | 'over-broad-profile' | 'token-spike'
  | 'unused-skill' | 'unused-command' | 'unused-agent'

/** What a finding is about. `profiles` is a duplicate group, its id the fingerprint (`fp-` + 12 hex). `cli` is a coverage
 *  gap's CLI and session kind, its id `claude-terminal`, `codex-chat` and so on. */
export type SubjectKind = 'profile' | 'profiles' | 'extension' | 'runtime' | 'credential' | 'job' | 'task' | 'run' | 'cli'

export interface FindingSubject {
  kind: SubjectKind
  id: string
  /** How a person names it: the profile's name, the server's name, the Job's name, names joined with ", " for a group. */
  name: string
}

/** Where the button beside a finding takes the person (spec §7: it opens the place, it never acts). */
export type FindingPlace =
  | { kind: 'profiles'; profileIds: string[] }
  | { kind: 'job'; jobId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'extension'; entryId: string }
  | { kind: 'policies' }
  | { kind: 'runtimes'; runtimeId: string }
  | { kind: 'credentials'; entryId: string }

export interface Finding {
  /** `${rule}:${subject.id}`, plus `:${part}` for over-broad-profile's lines (spec §6) and a coverage gap's Rule. */
  key: string
  rule: FindingRule
  subject: FindingSubject
  /** The profiles it concerns: its subject when that is a profile, a duplicate group's members, a coverage gap's affected
   *  profiles, a broken Job or Task's profile id. Empty when none. */
  profileIds: string[]
  /** §4.10: 'bypass' | 'sandbox' | `mcp:${entryId}`. §4.6: the Rule's id, since one CLI and session kind meets several
   *  Rules and each is ignored apart. */
  part?: string
  /** The reason, to be worded in the reader's language. */
  message: Message
  /** `message` in English, for the CLI and --json. */
  reason: string
  /** What would resolve it, to be worded. */
  suggestion: Message
  /** `suggestion` in English: the --json `action`. */
  action: string
  open: FindingPlace
  ignored: boolean
  /** When it was ignored, and the note, for an ignored one. */
  ignoredAt?: string
  note?: string
}

/** §4.12's "cannot tell" line: information, never a finding, never ignored. */
export interface InfoLine {
  subject: FindingSubject
  message: Message
  reason: string
}

/** `undefined` in FindingInputs = that source could not be read; its name goes here. */
export type FindingSource =
  | 'profiles' | 'accounts' | 'orchestration' | 'tokens' | 'policy' | 'records' | 'extensions' | 'account-mcp'
  | 'credentials' | 'credential-uses' | 'runtimes' | 'extension-uses' | 'ignored' | 'settings' | 'cli-version'

/** `days`: whole days of Observe history counted, 0..30 (history.ts). */
export interface ObserveHistory {
  on: boolean
  days: number
}

export interface FindingsReport {
  findings: Finding[]
  info: InfoLine[]
  /** How much Observe history the usage findings had. Not known when `policy` is in `unread`: it then reads
   *  `{ on: false, days: 0 }`, and a reader shows the unread line instead of the Observe note, never "Observe is off". */
  observe: ObserveHistory
  unread: FindingSource[]
  computedAt: string
}

// What the window's Observe records come to (§4.5, §4.10), built once by streaming the records (usage.ts) so no array of
// records is kept (Review Focus 5). Declared here so FindingInputs compiles before the builder exists.

export interface ProfileUse {
  calls: number
  /** Every record of the profile carried `effect`, and each was `read`. */
  allRead: boolean
  /** Every record carried `effect`; none had `sensitive`; none wrote outside its folder, by its headline or by a command in
   *  `commands` (rulings R2-2, R4-2):
   *  - a push, a pull request or a change on GitHub writes to the network, never outside;
   *  - a local git write is outside only with `insideProject` false;
   *  - any other write (a file write or delete, an install) is outside unless `insideProject` is true;
   *  - a call that may write (effect `unknown`, or a command that is not a read) is outside with `insideProject` false. */
  stayedInFolder: boolean
  /** The server part of each `mcp.call` target (`server.tool` → `server`). */
  mcpServers: Set<string>
}

export interface ObservedUse {
  byProfile: Map<string, ProfileUse>
  mcpServers: Set<string>
  /** A Claude chat session made a call in the window. A skill or command a person types into a chat (`-p`, stream-json)
   *  is expanded before the model runs, with no Skill call and no hook, so §4.12 cannot tell it went unused (ruling R-P2). */
  claudeChatSeen: boolean
}

/** The uses of shared skills, commands and agents the CLIs reported in the window (§4.12). */
export interface ExtensionUseSummary {
  /** Names used as a skill or command (skill-tool, slash), as reported. */
  skillOrCommand: Set<string>
  /** Agent names (subagent, agent-tool), as reported. */
  agents: Set<string>
}

/** What a shared skill or agent's canonical copy says of itself (§4.12), read from its frontmatter: the `name` Claude Code
 *  also knows it by (an agent's only name, in hooks and calls), and for an agent the skills its `skills:` preloads, which
 *  Claude Code injects with no event at all. */
export interface ExtensionCopy {
  name?: string
  skills?: string[]
}
