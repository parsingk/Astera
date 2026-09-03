/**
 * Which run configuration a project's toolbar should show.
 *
 * `preferred` is the choice remembered **for this project** — never simply "whatever was selected a
 * moment ago". That distinction is the whole point of this function. Seed configs are given ids
 * derived from the script name (`seed:npm:dev`, `seed:npm:start`; see seedKeyOf in ./config), with
 * nothing in them naming a project, so the same id exists in every npm project that has a script of
 * that name. Carrying the last selection across a project switch and keeping it "if it still
 * resolves" therefore does not detect the switch at all: it hands the new project the choice made in
 * the old one, and `dev`, `build`, `start` and `test` collide between npm projects as a matter of
 * course.
 *
 * The fallbacks are ordered by how much they know about intent: the user's own choice for this
 * project, then whatever is actually running in it, then the first config so the toolbar has
 * something to point at. Null only when the project has no configs — the toolbar's ▶ is guarded on
 * `!selectedId`, so null is what disables it.
 *
 * `activeConfigId` is optional because two of the callers reconcile after a delete or a save and
 * deliberately do not consider the running config.
 */
export function pickRunSelection(
  configs: readonly { id: string }[],
  preferred: string | null | undefined,
  activeConfigId?: string | null
): string | null {
  const has = (id: string | null | undefined): boolean =>
    typeof id === 'string' && configs.some((c) => c.id === id)
  if (has(preferred)) return preferred as string
  if (has(activeConfigId)) return activeConfigId as string
  return configs[0]?.id ?? null
}
