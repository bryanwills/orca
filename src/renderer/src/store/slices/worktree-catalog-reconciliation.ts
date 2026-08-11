import { structuralValuesEqualIgnoringUndefined } from '../../../../shared/structural-value-equality'

type CatalogRow = { id: string }

export function reuseEqualCatalogRows<T extends CatalogRow>(
  current: readonly T[] | undefined,
  incoming: readonly T[]
): T[] {
  if (!current) {
    return [...incoming]
  }
  const currentById = new Map<string, T[]>()
  for (const row of current) {
    const candidates = currentById.get(row.id)
    if (candidates) {
      candidates.push(row)
    } else {
      currentById.set(row.id, [row])
    }
  }
  const reconciled = incoming.map((row) => {
    const candidates = currentById.get(row.id)
    const previousIndex = candidates?.findIndex((candidate) =>
      structuralValuesEqualIgnoringUndefined(candidate, row)
    )
    return previousIndex !== undefined && previousIndex >= 0
      ? candidates!.splice(previousIndex, 1)[0]
      : row
  })
  return current.length === reconciled.length &&
    current.every((row, index) => row === reconciled[index])
    ? (current as T[])
    : reconciled
}

export function catalogRowsEqual<T extends CatalogRow>(
  current: readonly T[] | undefined,
  incoming: readonly T[]
): boolean {
  if (current === incoming) {
    return true
  }
  return reuseEqualCatalogRows(current, incoming) === current
}
