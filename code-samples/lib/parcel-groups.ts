import { SIM_STOCK_TYPES, type SimStockType } from './sim-stock'

// ONE BOX, ONE PARCEL (owner, 2026-10-20). When one dealer gets two physical card types in the same request, or in the same staff save, the cards go in ONE BOX, so the courier fee is
// entered ONCE. The database still makes one sim_orders row per card type (accept_dealer_request, create_sim_order_batch); this file is the ONE place that says which rows are one parcel,
// and every place that COUNTS a parcel or ASKS for a courier fee reads it: the To send list and its Confirm sent window, Add fee, the "sent, no courier fee" counts, the Monthly page's
// parcels, the nightly reports.
//
// THE KEY is the one the Stock page uses to merge the orders of one save (lib/intake-groups.ts orderEntryKey, which groupOrders uses; migration 0129 says it in SQL): the same dealer, the same
// moment the rows were saved (created_at), the same order date and the same state, pending or sent. For the physical kinds it leaves out ONE part, the exact moment a row was SENT:
// mark_sim_order_sent stamps every order with its own clock_timestamp(), so two orders sent together (found in production: one dealer's pair sent 6 milliseconds apart) never share it, and a key that
// carried it would split every box again the moment it was sent. The Stock out / Sent orders tabs group by the same key (orderEntryKey; an eSIM keeps its sent moment there, and is never a parcel here).
//
//   * only the two PHYSICAL kinds are parcels: an eSIM travels nowhere, so it is never part of one;
//   * a correction row (adjusts_id set) is never grouped: the extra parcel of a correction (migration 0125, cards ADDED to an order already sent) is its OWN parcel;
//   * a row with no created_at cannot be told to belong to anything, so it is a parcel on its own.
//
// THE FEE of a box is kept on its FIRST order (the smallest id) and RM 0 on the others: the money sums stay what they were (the sum of the fees) and the database never has to know about boxes.
// A box is "missing its fee" while ANY of its orders has no fee recorded (a fee of 0 is recorded): a box with the fee on the first and nothing on the rest is a save that stopped half way,
// and saving the fee again completes it (delivery/fee-save.ts saveParcelFee).

/** What the key reads off a row of sim_orders (or of a view of it). */
export type ParcelOrder = {
  id: string
  dealer_id: string
  order_date: string
  created_at?: string | null
  sim_type: string | null
  adjusts_id: string | null
  delivery_status?: string | null
}

/** The two kinds of card that go by courier. */
export const isParcelCardType = (t: string | null | undefined): boolean => t === 'physical' || t === 'physical_no_number'

/** A moment as milliseconds, so the same instant written two ways ("…+00:00" and "…Z") is one moment. A text that is no date stays as it is. */
const momentKey = (s: string): string => {
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? String(ms) : s
}

/** The key two rows share when they are one box. A row that can never be part of one is `alone|<id>`. */
export function parcelKey(o: ParcelOrder): string {
  const groupable = o.adjusts_id == null && !!o.created_at && isParcelCardType(o.sim_type)
  return groupable ? `${o.dealer_id}|${momentKey(o.created_at as string)}|${o.order_date}|${o.delivery_status ?? ''}` : `alone|${o.id}`
}

export type ParcelGroup<T> = {
  key: string
  /** The orders of the box, by id. One for a box that is one order. */
  rows: T[]
  /** The first order (the smallest id): where the box's courier fee is kept. */
  first: T
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The rows put into boxes, in the order each box was first met; the rows of a box by id. */
export function groupParcels<T extends ParcelOrder>(rows: readonly T[]): ParcelGroup<T>[] {
  const buckets = new Map<string, T[]>()
  for (const r of rows) {
    const key = parcelKey(r)
    const b = buckets.get(key)
    if (b) b.push(r)
    else buckets.set(key, [r])
  }
  return [...buckets].map(([key, bucket]) => {
    const sorted = [...bucket].sort(byId)
    return { key, rows: sorted, first: sorted[0] }
  })
}

/** How many parcels these rows are. */
export function parcelCount(rows: readonly ParcelOrder[]): number {
  return new Set(rows.map(parcelKey)).size
}

type FeeLike = { shipping_fee_rm?: number | string | null }

/** Where a box's fee is kept: the first order that already has one (so a fee recorded on another order of an old box is never doubled), else the first order. `rows` are by id. */
export function feeCarrier<T extends { id: string } & FeeLike>(rows: readonly T[]): T {
  return rows.find((r) => r.shipping_fee_rm != null) ?? rows[0]
}

/** True when every order of the box has a fee recorded (a fee of 0 is one). A box with none, or with only some, still needs its fee. */
export function boxHasFee(rows: readonly FeeLike[]): boolean {
  return rows.length > 0 && rows.every((r) => r.shipping_fee_rm != null)
}

/** What each card type of the box holds, in the order every screen lists the types (with number, no number); a type with no cards is left out. */
export function partsOf<T extends { sim_type: string | null }>(rows: readonly T[], cardsOf: (r: T) => number): { simType: SimStockType; cards: number }[] {
  return SIM_STOCK_TYPES.filter(isParcelCardType)
    .map((t) => ({ simType: t, cards: rows.filter((r) => r.sim_type === t).reduce((s, r) => s + cardsOf(r), 0) }))
    .filter((p) => p.cards !== 0)
}
