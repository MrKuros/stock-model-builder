import { useLayoutEffect, useRef } from 'react'
import { PageHead } from './Shell'
import { STATEMENTS, useHref } from './route'
import { fmt, type LayoutLine, type LineKind, type ModelDoc, type Parsed, type Projection, type Quarters, type Row, type Ttm } from './lib'

const TOTALS = new Set(['ebitda', 'pat', 'total_liab', 'total_assets', 'net_cf', 'fcf', 'fcff'])

/** The quarterly tab's inputs: the export's quarters, TTM (and a year earlier), the last reported year (and the one before). */
export interface QuarterProps { quarters: Quarters; ttm: Ttm | null; ttmPrev: Ttm | null; fy: string; last: Row; prev: Row | null }
const OPTIONAL = new Set(['cogs', 'lease', 'payables']) // shown only when some year has them
const NAMES = { base: 'base', bull: 'bull', bear: 'bear' } as const

/** Statements: one address per statement (/statements/profit-and-loss ...), history in ink and the active case's
 * forecast in blue. A row named in a link (#revenue) is focused and highlighted on arrival. */
export default function StatementsPage({ parsed, doc, projection, sub }: { parsed: Parsed; doc: ModelDoc; projection: Projection | null; sub: string }) {
  const href = useHref()
  const { company, years: histYears, layout } = parsed
  const hist = parsed.hist ?? company.hist
  const nHist = hist.length
  const n = doc.n, active = doc.active
  const proj = projection?.scenarios[active].length === n ? projection.scenarios[active] : null
  const years = proj ? [...histYears, ...projection!.years] : histYears
  const rows = proj ? [...hist, ...proj] : hist
  const quarterly: QuarterProps | null = company.quarters?.dates.length ? {
    quarters: company.quarters, ttm: parsed.ttm ?? null, ttmPrev: parsed.ttm_prev ?? null,
    fy: histYears[nHist - 1], last: hist[nHist - 1], prev: nHist > 1 ? hist[nHist - 2] : null,
  } : null
  const tabs = STATEMENTS.filter(t => t[0] !== 'quarters' || quarterly || sub === 'quarters')
  const cur = STATEMENTS.find(t => t[0] === sub) ?? STATEMENTS[0]
  const tab = cur[2] as string
  const hide = parsed.sources?.basis === 'cogs' ? undefined : new Set(['cogs'])
  return (
    <>
      <PageHead label={<>Statements · <b>{cur[1]}</b> · Rs crore</>} title={cur[1]}
        purpose={tab === 'QUARTERS'
          ? <>The last ten quarters as the company reported them, then the last full year and the trailing twelve months
            (TTM: the last four quarters added up), so the run rate sits next to the annual figure.</>
          : <>Every line as the company reported it ({histYears[0]}–{histYears[nHist - 1]}, in black), then our{' '}
            <b>{NAMES[active]}</b> case’s forecast in blue. Change the case and years at the top; change the inputs in Forecast.</>}
        next={<a className="btn" href={href('forecast')}>Change the forecast</a>} />
      <nav className="stmt-tabs" aria-label="Statements">
        {tabs.map(([id, name]) => <a key={id} href={href('statements', '', id)} aria-current={id === cur[0] ? 'true' : undefined}>{name}</a>)}
      </nav>
      <section className="statements" aria-labelledby="page-h">
        {tab !== 'QUARTERS' && proj && <p className="small dim scroll-hint">The table scrolls sideways: earlier years are to the left, the forecast ({projection!.years[0]}–{projection!.years[n - 1]}) to the right, in blue.</p>}
        {tab === 'QUARTERS'
          ? quarterly
            ? <div className="table-wrap" tabIndex={0} role="region" aria-label="Quarters"><QuarterTable {...quarterly} /></div>
            : <p className="val-empty">This Screener export has no quarterly figures. Exports that include the Quarters block
                show the last ten quarters and the trailing twelve months here.</p>
          : <StatementTable layout={layout} section={tab} years={years} rows={rows} nHist={nHist} hide={hide} />}
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
    </>
  )
}

function StatementTable({ layout, section, years, rows, nHist, hide }: {
  layout: LayoutLine[]; section: string; years: string[]; rows: Row[]; nHist: number; hide?: Set<string>
}) {
  const lines: [string, string, LineKind][] = []
  let at = ''
  for (const [label, key, kind] of layout) {
    if (kind === 'head') at = label
    else if (key && at === section && !hide?.has(key) && !(OPTIONAL.has(key) && rows.every(r => !r[key])))
      lines.push([label, key, kind as LineKind])
  }
  // a narrow screen opens on the latest reported year (next to the row names), not on the oldest
  const wrap = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const w = wrap.current
    if (!w || w.scrollWidth <= w.clientWidth) return
    const th = w.querySelectorAll<HTMLElement>('thead th')
    if (th[nHist]) w.scrollLeft = Math.max(0, th[nHist].offsetLeft - th[0].offsetWidth - 8)
  }, [section, nHist, years.length])
  return (
    <div className="table-wrap" ref={wrap} tabIndex={0} role="region" aria-labelledby="page-h">
      <table>
        <thead>
          <tr>
            <th scope="col">{section === 'RATIOS' ? 'Ratio' : 'Rs crore'}</th>
            {years.map((y, i) => <th scope="col" key={y} className={i >= nHist ? 'proj' : undefined}>{y}</th>)}
          </tr>
        </thead>
        <tbody>
          {lines.map(([label, key, kind]) => (
            <tr key={key} id={key} tabIndex={-1} className={TOTALS.has(key) ? 'total' : undefined}>
              <th scope="row">{label}</th>
              {rows.map((r, i) => (
                <td key={years[i]} className={i >= nHist ? 'proj' : undefined}>{fmt(r[key], kind)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
