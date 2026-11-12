import type { SupabaseClient } from '@supabase/supabase-js'

export type CreditBalance = { available: number; totalPurchased: number; totalCommitted: number }

// Below this, the balance can't cover one more ordinary top-up — pts stops being "fine" and starts being "you will get blocked on
// the next top-up." 1,000 points is the usual size of one dealer's top-up (the usual one is 1,000 points).
export const LOW_BALANCE_THRESHOLD = 1000

/** The tone of the mark for the points balance: rose = used up, amber = running low, grey = nothing bought yet (not an alarm, the system has not started). */
export type BalanceTone = 'bad' | 'wait' | 'off'

/**
 * ONE function for the colour of the balance's mark everywhere it is drawn (owner audit 2026-10-22: the top bar's balance chip had an AMBER dot while the Overview's Needs-you row for the very same
 * low balance had a ROSE one): the phone's top-bar chip, the Needs-you row (lib/notifications/build.ts turns the tone into the notice's variant, which is the row's dot). Null = the balance is fine,
 * nothing is drawn.
 */
export function balanceTone(available: number, totalPurchased: number): BalanceTone | null {
  if (available >= LOW_BALANCE_THRESHOLD) return null
  if (totalPurchased <= 0) return 'off'
  return available <= 0 ? 'bad' : 'wait'
}

// "Available" = total points ever bought from Vibe Mobile (credit_purchases)
// minus everything already committed to a dealer. A *pending* transaction
// still counts as committed — the dealer has already received that credit in
// practice, it just hasn't been double-checked yet — only flagged (voided)
// transactions are excluded. This is the single definition of balance used
// both to hard-block New transaction when there isn't enough stock, and to
// display the running balance on /purchases — deliberately the same number
// in both places rather than two subtly different "balance" figures.
//
// Split from the data fetch below so this arithmetic — the actual thing that
// decides whether a sale gets blocked — can be unit tested without a live
// database. See credit-balance.test.ts.
export function computeAvailableBalance(totalPurchased: number, totalCommitted: number): number {
  return totalPurchased - totalCommitted
}

// Sourced from a real server-side aggregate (0016), not a pull-every-row-and-
// sum-in-JS — the old approach had no row limit and would silently
// undercount totalCommitted (making available look *bigger* than reality,
// the unsafe direction) once transactions crossed PostgREST's per-request
// row cap. A single-row aggregate is immune to that regardless of table
// size, and it's the same query the DB-level insert trigger enforces the
// hard-block with (0016), so the app's fast-path check and the real backstop
// can never quietly disagree.
//
// A failed read is an ERROR, never a balance of zero. This used to ignore the error and treat
// "no data" as 0 — so when the read timed out under load, the dashboard printed "Credit 0 pts",
// the low-balance alert said "Out of credit — buy from Vibe Mobile", and New transaction refused
// sales with "Not enough credit balance: 0 pts available": a false and alarming figure standing
// in for one we simply could not read. One retry first (a timeout is usually a busy moment, not a
// broken database), then it throws, which the page's error boundary and Sentry both see.
export async function getAvailablePointsBalance(supabase: SupabaseClient): Promise<CreditBalance> {
  type Row = { total_purchased: number; total_committed: number; available: number }
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = (await supabase.rpc('get_credit_balance').single()) as {
      data: Row | null
      error: { message: string } | null
    }
    if (!error && data) {
      const totalPurchased = Number(data.total_purchased ?? 0)
      const totalCommitted = Number(data.total_committed ?? 0)
      return { available: computeAvailableBalance(totalPurchased, totalCommitted), totalPurchased, totalCommitted }
    }
    last = error?.message ?? 'no row returned'
  }
  throw new Error(`Could not read the points balance: ${last}`)
}

/**
 * How long the credit on hand lasts at the rate it is being sold.
 *
 * Nothing in this app answers "when do I need to buy from Vibe again" — the
 * balance is printed on three pages and the burn rate on none, so the owner
 * does the division in his head. Both numbers were already on the dashboard.
 *
 * Returns null when there is nothing to divide by, and that matters: on
 * production today there are zero transactions, so a runway would be either
 * a crash or a meaningless infinity. A figure that cannot exist yet does not
 * get a placeholder — the same rule Reconciliation is built on.
 *
 * Moved here from dashboard/page.tsx (both master's and accountant's
 * branches called it, and it belongs beside the balance it divides) so it can
 * be unit tested — see runwayNote just below for the other half of this bug:
 * the arithmetic here was always correct, but hands back a real number no
 * matter how large, and a balance bought months ago divided by a nearly-idle
 * current period produced "~3,392,460 days left" rather than anything a
 * reader could act on.
 */
export function creditRunwayDays(available: number, soldThisPeriod: number, elapsedDays: number): number | null {
  if (available <= 0 || soldThisPeriod <= 0 || elapsedDays <= 0) return null
  const perDay = soldThisPeriod / elapsedDays
  if (!Number.isFinite(perDay) || perDay <= 0) return null
  return Math.floor(available / perDay)
}

// Past this many days, the exact count stops telling the reader anything a
// rounder answer wouldn't: "~100,154 days left" and "~3,392,460 days left"
// are both just "this period's volume is tiny next to a balance bought in
// bulk a while ago" restated with false precision. A year is already well
// past the 45-day cutoff runwayNote treats as safe below, so nothing real is
// lost by saying "plenty" instead of naming the exact day six-figure count.
export const RUNWAY_PLENTY_DAYS = 365

// Below this, the reader needs to act soon; below the next one, it's worth
// watching. Named here so runwayNote's thresholds are one set of numbers,
// not three copies of 15 and 45 scattered across whichever pages show this.
const RUNWAY_LOW_DAYS = 15
const RUNWAY_WATCH_DAYS = 45

export type RunwayTone = 'low' | 'watch' | 'safe'
export type RunwayNote = { text: string; tone: RunwayTone }

/**
 * Turns creditRunwayDays' raw count into what a reader should actually see.
 *
 * Split from the arithmetic on purpose: creditRunwayDays' division was never
 * wrong, so fixing this bug does not mean changing what it returns, only
 * capping how a genuinely huge result gets shown. Below the cap, the exact
 * count still says something useful (how many days, not just "fine"), so it
 * stays a number — only past RUNWAY_PLENTY_DAYS does the count stop being
 * information and start being noise.
 *
 * `runwayDays == null` covers both "nothing sold this period" (nothing to
 * divide by) and "no balance at all" — the low-balance warning only makes
 * sense for the first of those two, hence checking `available` again here
 * rather than treating every null the same way.
 */
export function runwayNote(runwayDays: number | null, available: number, lowBalanceThreshold: number, basis?: string): RunwayNote | null {
  if (runwayDays == null) {
    if (available < lowBalanceThreshold) return { text: 'below the low-balance threshold', tone: 'watch' }
    return null
  }
  const tail = basis ? `, ${basis}` : ''
  if (runwayDays > RUNWAY_PLENTY_DAYS) return { text: `plenty of runway at this rate${tail}`, tone: 'safe' }
  const tone: RunwayTone = runwayDays < RUNWAY_LOW_DAYS ? 'low' : runwayDays < RUNWAY_WATCH_DAYS ? 'watch' : 'safe'
  return { text: `about ${runwayDays} ${runwayDays === 1 ? 'day' : 'days'} left at this rate${tail}`, tone }
}
