import type { WorkUnitStatus } from './types'

/** Can this unit still receive observations? Only while it is active. An interrupted unit is
 *  waiting for a person, not for more work: nothing may be added to it, and completing it from
 *  the screen closes it with what it already holds. */
export const isOpen = (status: WorkUnitStatus): boolean => status === 'active'
