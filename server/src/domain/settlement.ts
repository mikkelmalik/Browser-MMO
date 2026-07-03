export interface StoreState {
  amount: number
  ratePerHour: number
  capacity: number
  settledAt: Date
}

const HOUR_MS = 3_600_000

/**
 * Read-time settlement (ADR-0001): compute the store's value at `until` from
 * its last settled amount and rate. Accrual is clamped to [0, capacity] and,
 * when the Outpost is Dormant, stops at `dormantAt`. `settledAt` always
 * advances to `until` so the skipped window is never re-credited.
 */
export function settleStore(
  store: StoreState,
  until: Date,
  dormantAt?: Date | null,
): StoreState {
  if (until <= store.settledAt) return store

  let windowEnd = until
  if (dormantAt && dormantAt < windowEnd) windowEnd = dormantAt

  let amount = store.amount
  if (windowEnd > store.settledAt) {
    const hours = (windowEnd.getTime() - store.settledAt.getTime()) / HOUR_MS
    amount = Math.min(store.capacity, Math.max(0, amount + store.ratePerHour * hours))
  }

  return { ...store, amount, settledAt: until }
}

/**
 * The projected instant this Water store hits zero — the moment its Outpost
 * goes Dormant. Null when the store never runs dry at current rates.
 */
export function computeDormantAt(water: StoreState): Date | null {
  if (water.ratePerHour >= 0) return null
  const hoursUntilDry = water.amount / -water.ratePerHour
  return new Date(water.settledAt.getTime() + hoursUntilDry * HOUR_MS)
}
