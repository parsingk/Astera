// Pure text for Higgsfield accounts, shared by the CLI side and the Settings tab (no Node imports, so the
// renderer can use it).

export interface HfWorkspace { id: string; name: string | null; plan: string | null; credits: number | null }

/** CLI 1.1.24 with no config.json (a fresh login): `Error: No workspace selected.` / `Hint: Run: hf
 *  workspace set <workspace_id>`, exit 4. */
export const NO_WORKSPACE = /no workspace selected/i

/** What the agent is told about an account without a workspace (the proxy prefixes `higgsfield: `). */
export const noWorkspaceText = (label: string): string =>
  `Higgsfield account "${label}" has no workspace selected. Ask the user to pick one in Astera Settings > Creative Hub > Higgsfield; do not run workspace commands yourself.`

/** `label · email`, or the label alone when there is no email or it is the same (an account named after
 *  its email). */
export function hfAccountTitle(label: string, email: string | undefined): string {
  if (!email || email.trim().toLowerCase() === label.trim().toLowerCase()) return label
  return `${label} · ${email}`
}

/** A workspace in a picker: its name, else its plan, else the first part of its id; then its credits. */
export function hfWorkspaceLabel(w: HfWorkspace, credits: (n: number) => string): string {
  const base = w.name ?? w.plan ?? w.id.split('-')[0].slice(0, 8)
  return w.credits === null ? base : `${base} · ${credits(w.credits)}`
}
