// Read every row of a query, not just the first thousand.
//
// This project's API returns at most 1,000 rows per request (max_rows) and cuts the
// rest off WITHOUT an error. A page that reads rows and then adds them up — a month's
// points, who is owed cards, how many are pending — is therefore right until the
// thousand-and-first row and quietly wrong after it, with nothing on screen to say so.
// Measured on the demo with 12,000 transactions: "this month's earnings" read RM 34,121
// where the real figure was RM 409,982, and a reconciliation compared against a third of
// the month's points.
//
// The page function is called with the inclusive row range to ask for. Give it a
// stable ORDER (an `.order('id')` tiebreaker at least): paging an unordered query can
// repeat or skip rows between requests.
//
//   const rows = await fetchAll((from, to) =>
//     supabase.from('transactions').select('points, status').eq('status', 'verified').order('id').range(from, to))
//
// For a plain total or a count, prefer a SQL aggregate or `head: true` — it moves one
// row instead of the whole table. This is for the places that genuinely need the rows.
export const API_PAGE_SIZE = 1000

type Page<T> = { data: T[] | null; error: { message: string } | null }

// A backstop, not a target: past this many rows the right answer is an aggregate in
// SQL, and failing loudly beats a page that hangs reading a table it should be summing.
const MAX_ROWS = 200_000
// Once the first page comes back full there is more, so the rest are asked for a few at
// a time. The first page is always alone: most queries are small and must cost one request.
const PARALLEL = 4

export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<Page<T>>): Promise<T[]> {
  const rows: T[] = []
  const take = (res: Page<T>): number => {
    // An error must not read as "no more rows": that would return a short list that
    // looks complete, which is exactly the failure this exists to prevent.
    if (res.error) throw new Error(`fetchAll: ${res.error.message}`)
    const got = res.data ?? []
    rows.push(...got)
    return got.length
  }

  if (take(await page(0, API_PAGE_SIZE - 1)) < API_PAGE_SIZE) return rows

  for (let start = API_PAGE_SIZE; ; start += API_PAGE_SIZE * PARALLEL) {
    const batch = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => {
        const from = start + i * API_PAGE_SIZE
        return page(from, from + API_PAGE_SIZE - 1)
      }),
    )
    // In order, stopping at the first short page: anything after it is empty.
    for (const res of batch) if (take(res) < API_PAGE_SIZE) return rows
    if (rows.length >= MAX_ROWS) throw new Error(`fetchAll: more than ${MAX_ROWS.toLocaleString()} rows — aggregate this in SQL instead`)
  }
}

/**
 * The first `limit` rows of a query, starting `offset` rows in, however large `limit` is: read in steps of the API's 1,000 rows (a request for more would be cut at 1,000 without a word).
 * For a list shown by "the first N" (a desk tab's "Show 20 more", which grows N): the page function is called with the inclusive row range to ask for and must have a TOTAL order, as fetchAll's.
 * Stops at a short page, so a list shorter than `limit` costs one request. An error throws.
 */
export async function fetchUpTo<T>(limit: number, page: (from: number, to: number) => PromiseLike<Page<T>>, offset = 0): Promise<T[]> {
  const rows: T[] = []
  const want = Math.max(0, Math.trunc(limit))
  for (let from = offset; rows.length < want; ) {
    const take = Math.min(API_PAGE_SIZE, want - rows.length)
    const res = await page(from, from + take - 1)
    if (res.error) throw new Error(`fetchUpTo: ${res.error.message}`)
    const got = res.data ?? []
    rows.push(...got)
    if (got.length < take) break
    from += take
  }
  return rows
}

// The same rows, in the `{ data }` shape a Supabase query resolves to, so a page that
// destructures `{ data: rows }` out of a Promise.all can swap its query for this and
// change nothing else.
export async function allRows<T>(page: (from: number, to: number) => PromiseLike<Page<T>>): Promise<{ data: T[] }> {
  return { data: await fetchAll(page) }
}
