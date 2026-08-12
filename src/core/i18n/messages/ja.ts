import type { Catalog } from '../index'

/** Japanese. Partial by design: a key that is not here falls back to English, then to Korean, so a new
 *  string can ship before its translation does. */
export const ja: Catalog = {}
