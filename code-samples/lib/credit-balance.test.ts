import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  computeAvailableBalance,
  getAvailablePointsBalance,
  LOW_BALANCE_THRESHOLD,
  creditRunwayDays,
  runwayNote,
  RUNWAY_PLENTY_DAYS,
} from './credit-balance'

describe('computeAvailableBalance', () => {
  it('is total purchased minus total committed', () => {
    expect(computeAvailableBalance(1000, 600)).toBe(400)
  })

  it('blocks a sale bigger than what remains (New transaction hard-block)', () => {
    const available = computeAvailableBalance(1000, 600)
    const requestedSale = 500
    expect(requestedSale > available).toBe(true)
  })

  it('allows a sale that fits within what remains', () => {
    const available = computeAvailableBalance(1000, 600)
    const requestedSale = 400
    expect(requestedSale > available).toBe(false)
  })

  it('goes negative if more was committed than purchased (already-oversold state, not clamped)', () => {
    expect(computeAvailableBalance(500, 600)).toBe(-100)
  })

  it('treats zero purchases as zero balance, not a crash', () => {
    expect(computeAvailableBalance(0, 0)).toBe(0)
  })
})

describe('LOW_BALANCE_THRESHOLD', () => {
  it('is 1,000 points, the usual size of one top-up, so it warns before the next ordinary top-up would be blocked', () => {
    expect(LOW_BALANCE_THRESHOLD).toBe(1000)
  })
})

// A stand-in client whose get_credit_balance answers are queued, one per call.
function clientReturning(...answers: { data: unknown; error: { message: string } | null }[]) {
  let calls = 0
  const client = { rpc: () => ({ single: async () => answers[Math.min(calls++, answers.length - 1)] }) } as unknown as SupabaseClient
  return { client, calls: () => calls }
}
const ok = { data: { total_purchased: 1000, total_committed: 600, available: 400 }, error: null }

describe('getAvailablePointsBalance', () => {
  it('returns the balance the database worked out', async () => {
    const { client } = clientReturning(ok)
    expect(await getAvailablePointsBalance(client)).toEqual({ available: 400, totalPurchased: 1000, totalCommitted: 600 })
  })

  it('retries once, so a single timeout is not a failure', async () => {
    const { client, calls } = clientReturning({ data: null, error: { message: 'canceling statement due to statement timeout' } }, ok)
    expect((await getAvailablePointsBalance(client)).available).toBe(400)
    expect(calls()).toBe(2)
  })

  it('throws rather than reporting a balance of zero when it cannot read one', async () => {
    const { client } = clientReturning({ data: null, error: { message: 'statement timeout' } })
    await expect(getAvailablePointsBalance(client)).rejects.toThrow('statement timeout')
  })

  it('a genuine zero balance is still zero', async () => {
    const { client } = clientReturning({ data: { total_purchased: 0, total_committed: 0, available: 0 }, error: null })
    expect((await getAvailablePointsBalance(client)).available).toBe(0)
  })
})

describe('creditRunwayDays', () => {
  it('divides the balance by the daily rate', () => {
    // 1,000 available, 100 sold over 10 days = 10/day = 100 days of runway.
    expect(creditRunwayDays(1000, 100, 10)).toBe(100)
  })

  it('floors rather than rounds, so it never claims a day the balance cannot fully cover', () => {
    // 3 points/day (3 sold in 1 day). 10 available covers 3 full days and a
    // third of a fourth (10/3 = 3.33) — floored to 3, not rounded up to 4.
    expect(creditRunwayDays(10, 3, 1)).toBe(3)
  })

  it('is null when nothing was sold this period — nothing to divide by, not an infinity', () => {
    expect(creditRunwayDays(1000, 0, 10)).toBeNull()
  })

  it('is null when there is no balance left', () => {
    expect(creditRunwayDays(0, 100, 10)).toBeNull()
  })

  it('is null when no time has elapsed yet', () => {
    expect(creditRunwayDays(1000, 100, 0)).toBeNull()
  })

  it('is null for an already-oversold (negative) balance rather than a negative runway', () => {
    expect(creditRunwayDays(-50, 100, 10)).toBeNull()
  })

  // The actual bug: a balance bought in bulk a while ago, divided by a
  // current period that has barely started selling. The division itself is
  // correct — this just documents that creditRunwayDays keeps returning the
  // real (huge) number. Capping it is runwayNote's job below, deliberately
  // kept out of this function so the arithmetic stays honest and testable on
  // its own.
  it('returns the real huge number for a near-idle period next to a bulk-bought balance — capping is runwayNote’s job', () => {
    // 888,132 available (this app's own demo balance tonight), 8 points sold
    // over 30 days — close to the ~3,392,460-day reading actually seen.
    expect(creditRunwayDays(888132, 8, 30)).toBe(3330495)
  })

  it('stays finite and sane for an ordinary, comparable rate', () => {
    // A balance that would last about 45 days at a steady, realistic rate.
    expect(creditRunwayDays(45000, 30000, 30)).toBe(45)
  })
})

describe('runwayNote', () => {
  it('says day, not days, for one day', () => {
    expect(runwayNote(1, 5000, LOW_BALANCE_THRESHOLD)).toEqual({ text: 'about 1 day left at this rate', tone: 'low' })
  })

  it('shows the exact count, red, when it is running out soon', () => {
    expect(runwayNote(10, 5000, LOW_BALANCE_THRESHOLD)).toEqual({ text: 'about 10 days left at this rate', tone: 'low' })
  })

  it('shows the exact count, amber, in the watch band', () => {
    expect(runwayNote(30, 5000, LOW_BALANCE_THRESHOLD)).toEqual({ text: 'about 30 days left at this rate', tone: 'watch' })
  })

  it('shows the exact count, green, once comfortably past the watch band', () => {
    expect(runwayNote(100, 5000, LOW_BALANCE_THRESHOLD)).toEqual({ text: 'about 100 days left at this rate', tone: 'safe' })
  })

  it('is exactly at the low/watch boundary correctly (15 is watch, 14 is low)', () => {
    expect(runwayNote(15, 5000, LOW_BALANCE_THRESHOLD)!.tone).toBe('watch')
    expect(runwayNote(14, 5000, LOW_BALANCE_THRESHOLD)!.tone).toBe('low')
  })

  it('is exactly at the watch/safe boundary correctly (45 is safe, 44 is watch)', () => {
    expect(runwayNote(45, 5000, LOW_BALANCE_THRESHOLD)!.tone).toBe('safe')
    expect(runwayNote(44, 5000, LOW_BALANCE_THRESHOLD)!.tone).toBe('watch')
  })

  // The actual bug this fixes: real, correct division producing a
  // multi-century number. Past RUNWAY_PLENTY_DAYS this stops being a count at
  // all — the exact figure was never the point past that threshold, "you are
  // fine" is.
  it('replaces a huge day count with "plenty of runway" instead of the raw number', () => {
    const note = runwayNote(3330495, 888132, LOW_BALANCE_THRESHOLD)
    expect(note).toEqual({ text: 'plenty of runway at this rate', tone: 'safe' })
    expect(note!.text).not.toMatch(/\d/)
  })

  it('is exactly at the plenty boundary correctly (one day past the cap says "plenty", the cap itself still counts)', () => {
    expect(runwayNote(RUNWAY_PLENTY_DAYS, 5000, LOW_BALANCE_THRESHOLD)).toEqual({
      text: `about ${RUNWAY_PLENTY_DAYS} days left at this rate`,
      tone: 'safe',
    })
    expect(runwayNote(RUNWAY_PLENTY_DAYS + 1, 5000, LOW_BALANCE_THRESHOLD)!.text).toBe('plenty of runway at this rate')
  })

  it('warns on a low balance instead of showing nothing, when there is nothing to divide by', () => {
    expect(runwayNote(null, 500, LOW_BALANCE_THRESHOLD)).toEqual({ text: 'below the low-balance threshold', tone: 'watch' })
  })

  it('shows nothing when there is nothing to divide by but the balance itself is still healthy', () => {
    expect(runwayNote(null, 50000, LOW_BALANCE_THRESHOLD)).toBeNull()
  })
})
