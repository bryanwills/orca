import type { Repo } from '../../../../shared/types'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { getRepoHostIdentity } from './repo-host-identity'

// Why: after a drag-reorder we optimistically set `repos`, persist, and main
// broadcasts `repos:changed`. The renderer's own echo handler refetches, which
// would otherwise hand back field-identical repos as brand-new objects. New
// identities invalidate the repoMap/repoOrder/rows memos and force the
// virtualizer to rebuild + re-measure a tick after the drop — the visible jump.
// Reusing equal objects (and the whole array when nothing moved) makes the echo
// a no-op render.
// Why the structural compare: `Repo` carries nested records (hookSettings, upstream,
// gitRemoteIdentity, repoIcon, path arrays) that structured-clone and main's hydrateRepo rebuild
// every fetch, so a reference compare would report every repo as changed.

/**
 * Reuses equal rows from `previous` — and the whole array when nothing moved — so a refetch that
 * changed nothing leaves identity-keyed memos and store subscribers untouched. `getIdentity` must
 * be the key the producing merge already dedups by, so it is unique within `next`.
 */
export function reconcileCatalogRows<T>(
  previous: readonly T[],
  next: readonly T[],
  getIdentity: (row: T) => string
): readonly T[] {
  const previousByIdentity = new Map(previous.map((row) => [getIdentity(row), row]))
  let identical = next.length === previous.length
  const reconciled = next.map((row, index) => {
    const existing = previousByIdentity.get(getIdentity(row))
    if (existing !== undefined && structuralValuesEqual(existing, row)) {
      if (existing !== previous[index]) {
        identical = false
      }
      return existing
    }
    identical = false
    return row
  })
  return identical ? previous : reconciled
}

export function reconcileFetchedRepos(
  previous: readonly Repo[],
  next: readonly Repo[]
): readonly Repo[] {
  return reconcileCatalogRows(previous, next, getRepoHostIdentity)
}
