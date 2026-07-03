import { describe, expect, test } from 'vitest'
import {
  computeDormantAt,
  settleStore,
  type StoreState,
} from '../src/domain/settlement.js'

const at = (iso: string) => new Date(iso)

const store = (partial: Partial<StoreState>): StoreState => ({
  amount: 0,
  ratePerHour: 0,
  capacity: 1000,
  settledAt: at('2026-07-03T00:00:00Z'),
  ...partial,
})

describe('settleStore', () => {
  test('accrues linearly from settledAt to until', () => {
    const s = settleStore(store({ amount: 10, ratePerHour: 5 }), at('2026-07-03T02:00:00Z'))
    expect(s.amount).toBe(20)
    expect(s.settledAt).toEqual(at('2026-07-03T02:00:00Z'))
  })

  test('clamps at capacity (storage caps are the catch-up mechanic)', () => {
    const s = settleStore(
      store({ amount: 990, ratePerHour: 5, capacity: 1000 }),
      at('2026-07-03T10:00:00Z'),
    )
    expect(s.amount).toBe(1000)
  })

  test('floors at zero with a negative rate (Water upkeep)', () => {
    const s = settleStore(
      store({ amount: 10, ratePerHour: -5 }),
      at('2026-07-03T05:00:00Z'),
    )
    expect(s.amount).toBe(0)
  })

  test('accrual stops at dormantAt even when until is later', () => {
    // Outpost went Dormant at 01:00; settling at 03:00 must only credit 1 hour.
    const s = settleStore(
      store({ amount: 0, ratePerHour: 10 }),
      at('2026-07-03T03:00:00Z'),
      at('2026-07-03T01:00:00Z'),
    )
    expect(s.amount).toBe(10)
    // settledAt still advances to `until` so the store is not re-credited later
    expect(s.settledAt).toEqual(at('2026-07-03T03:00:00Z'))
  })

  test('dormantAt before settledAt means no accrual at all', () => {
    const s = settleStore(
      store({ amount: 7, ratePerHour: 10, settledAt: at('2026-07-03T02:00:00Z') }),
      at('2026-07-03T03:00:00Z'),
      at('2026-07-03T01:00:00Z'),
    )
    expect(s.amount).toBe(7)
  })

  test('until earlier than settledAt does not rewind (no time travel)', () => {
    const s = settleStore(
      store({ amount: 10, ratePerHour: 5, settledAt: at('2026-07-03T02:00:00Z') }),
      at('2026-07-03T01:00:00Z'),
    )
    expect(s.amount).toBe(10)
    expect(s.settledAt).toEqual(at('2026-07-03T02:00:00Z'))
  })
})

describe('computeDormantAt', () => {
  test('projects the instant Water hits zero at a negative rate', () => {
    const dormantAt = computeDormantAt(store({ amount: 30, ratePerHour: -10 }))
    expect(dormantAt).toEqual(at('2026-07-03T03:00:00Z'))
  })

  test('null when Water rate is non-negative (never runs dry)', () => {
    expect(computeDormantAt(store({ amount: 30, ratePerHour: 0 }))).toBeNull()
    expect(computeDormantAt(store({ amount: 30, ratePerHour: 2 }))).toBeNull()
  })

  test('already-empty store with negative rate is dormant immediately', () => {
    const dormantAt = computeDormantAt(store({ amount: 0, ratePerHour: -1 }))
    expect(dormantAt).toEqual(at('2026-07-03T00:00:00Z'))
  })
})
