import { useState } from 'react'
import { fmt, groupKeys, type LayoutLine, type LineKind, type Quarters, type Row, type Ttm } from './lib'

const TOTALS = new Set(['ebitda', 'pat', 'total_liab', 'total_assets', 'net_cf', 'fcf', 'fcff'])
const ALL_TABS = [['PROFIT & LOSS', 'Profit & loss'], ['BALANCE SHEET', 'Balance sheet'], ['CASH FLOW', 'Cash flow'],
  ['RATIOS', 'Ratios'], ['QUARTERS', 'Quarters']] as const

/** The quarterly tab's inputs: the export's quarters, TTM (and a year earlier), the last reported year (and the one before). */
export interface QuarterProps { quarters: Quarters; ttm: Ttm | null; ttmPrev: Ttm | null; fy: string; last: Row; prev: Row | null }
interface Props {
  layout: LayoutLine[]; years: string[]; rows: Row[]; nHist: number; quarterly: QuarterProps | null
  hide?: Set<string> // lines that mean nothing for this company (COGS when days run on revenue)
}
const OPTIONAL = new Set(['cogs', 'lease', 'payables']) // shown only when some year has them

export default function Statements({ layout, years, rows, nHist, quarterly, hide }: Props) {
  const TABS = quarterly ? ALL_TABS : ALL_TABS.slice(0, 4) // no Quarters block in the export: no tab
  const [picked, setTab] = useState<string>(TABS[0][0])
  const tab = TABS.some(t => t[0] === picked) ? picked : TABS[0][0]
  const lines: [string, string, LineKind][] = []
  let section = ''
  for (const [label, key, kind] of layout) {
    if (kind === 'head') section = label
    else if (key && section === tab && !hide?.has(key) && !(OPTIONAL.has(key) && rows.every(r => !r[key])))
      lines.push([label, key, kind as LineKind])
  }

  return (
    <section className="statements" aria-label="Financial statements">
      <div className="tabs" role="tablist" aria-label="Statement">
        {TABS.map(([id, name], i) => (
          <button key={id} id={`stmt-tab-${i}`} role="tab" type="button" aria-selected={tab === id} className="tab"
            aria-controls="stmt-panel" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}
            onKeyDown={e => groupKeys(e, TABS.map(t => t[0] as string), tab, setTab)}>
            {name}
          </button>
        ))}
      </div>
      <div className="table-wrap" id="stmt-panel" role="tabpanel" tabIndex={0}
        aria-labelledby={`stmt-tab-${TABS.findIndex(t => t[0] === tab)}`}>
        {tab === 'QUARTERS' && quarterly ? <QuarterTable {...quarterly} /> : <table>
          <thead>
            <tr>
              <th scope="col">{tab === 'RATIOS' ? 'Ratio' : 'Rs crore'}</th>
              {years.map((y, i) => <th scope="col" key={y} className={i >= nHist ? 'proj' : undefined}>{y}</th>)}
            </tr>
          </thead>
          <tbody>
            {lines.map(([label, key, kind]) => (
              <tr key={key} className={TOTALS.has(key) ? 'total' : undefined}>
                <th scope="row">{label}</th>
                {rows.map((r, i) => (
                  <td key={years[i]} className={i >= nHist ? 'proj' : undefined}>{fmt(r[key], kind)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>}
      </div>
      {tab === 'RATIOS' && (
        <p className="muted small">
          ROE = net profit / average equity. ROCE = EBIT / average (equity + borrowings + lease liabilities), EBIT = profit before tax +
          interest. Asset turnover = revenue / average total assets. Averages use opening and closing balances; the
          first year uses closing. Net debt = borrowings + lease liabilities − cash − investments. – means not meaningful (zero or
          negative denominator).
        </p>
      )}
      {tab === 'QUARTERS' && quarterly && (
        <p className="muted small">
          As reported, last {Math.min(quarterly.quarters.dates.length, SHOW)} quarters. Operating profit = profit before
          tax + interest + depreciation − other income, the same as EBITDA in the yearly tables. TTM (trailing twelve
          months) adds up the last four quarters{quarterly.ttm ? ` to ${month(quarterly.ttm.end)}` : ''}. YoY (year
          on year) compares a quarter with the same quarter a year earlier, and TTM with the four quarters before it.
          {!quarterly.ttm && ' No TTM here: the last four quarters in the file aren’t consecutive.'}
        </p>
      )}
    </section>
  )
}

const SHOW = 10 // Screener exports ten quarters
const DAY = 86_400_000
/** "2021-12-31T00:00:00" -> "Dec 2021" */
export const month = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
/** a / b - 1, blank when the base isn't positive (growth off a loss means nothing) */
export const growth = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && b > 0 ? a / b - 1 : null
const margin = (op: number | null | undefined, sales: number | null | undefined) =>
  op != null && sales ? op / sales : null

/** Last ten quarters in ink, then the last reported year and TTM, so the run rate sits next to the annual figure. */
function QuarterTable({ quarters, ttm, ttmPrev, fy, last, prev }: QuarterProps) {
  const { dates, rows: q } = quarters
  const from = Math.max(0, dates.length - SHOW)
  const idx = dates.map((_, i) => i).slice(from)
  // same quarter a year earlier: four back, and really ~365 days back (a missing quarter shifts the index)
  const yearAgo = (i: number) =>
    i >= 4 && Math.abs((Date.parse(dates[i]) - Date.parse(dates[i - 4])) / DAY - 365) <= 15 ? i - 4 : -1
  const at = (k: string, i: number) => (i < 0 ? null : q[k]?.[i] ?? null)
  const t = ttm?.values, tp = ttmPrev?.values
  const lines: [string, LineKind, (i: number) => number | null, number | null, number | null][] = [
    // label, kind, quarter i, last FY, TTM
    ['Sales', 'num', i => at('sales', i), last.revenue, t?.sales ?? null],
    ['Operating profit', 'num', i => at('op_profit', i), last.ebitda, t?.op_profit ?? null],
    ['Operating margin', 'pct', i => margin(at('op_profit', i), at('sales', i)), margin(last.ebitda, last.revenue),
      margin(t?.op_profit, t?.sales)],
    ['Net profit', 'num', i => at('net_profit', i), last.pat, t?.net_profit ?? null],
    ['Sales growth YoY', 'pct', i => growth(at('sales', i), at('sales', yearAgo(i))),
      growth(last.revenue, prev?.revenue), growth(t?.sales, tp?.sales)],
    ['Net profit growth YoY', 'pct', i => growth(at('net_profit', i), at('net_profit', yearAgo(i))),
      growth(last.pat, prev?.pat), growth(t?.net_profit, tp?.net_profit)],
  ]
  return (
    <table className="q-table">
      <thead>
        <tr>
          <th scope="col">Rs crore</th>
          {idx.map(i => <th scope="col" key={dates[i]}>{month(dates[i])}</th>)}
          <th scope="col" className="q-sum">{fy}</th>
          {ttm && <th scope="col" className="q-sum"><abbr title="Trailing twelve months">TTM</abbr> {month(ttm.end)}</th>}
        </tr>
      </thead>
      <tbody>
        {lines.map(([label, kind, f, fyv, tv]) => (
          <tr key={label} className={label === 'Net profit' ? 'total' : undefined}>
            <th scope="row">{label}</th>
            {idx.map(i => <td key={dates[i]}>{fmt(f(i), kind)}</td>)}
            <td className="q-sum">{fmt(fyv, kind)}</td>
            {ttm && <td className="q-sum">{fmt(tv, kind)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
