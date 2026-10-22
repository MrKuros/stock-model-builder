import { useRef, type ReactNode } from 'react'
import { Next, PageHead } from './Shell'
import { STATEMENTS, navigate, useHref } from './route'
import { fmt, fy, money, properName, qfy, type LayoutLine, type LineKind, type ModelDoc, type Parsed, type Projection, type Quarters, type Row, type Ttm } from './lib'
import { T } from './Term'

const TOTALS = new Set(['ebitda', 'pat', 'total_liab', 'total_assets', 'net_cf', 'fcf', 'fcff', 'nii', 'ppop', 'equity'])

/** The quarterly tab's inputs: the export's quarters, TTM (and a year earlier), the last reported year (and the one before). */
export interface QuarterProps { quarters: Quarters; ttm: Ttm | null; ttmPrev: Ttm | null; year: string; last: Row; prev: Row | null }
const OPTIONAL = new Set(['cogs', 'lease', 'payables']) // shown only when some year has them
import { NAMES } from './lib'

/** Statements: one address per statement (/statements/profit-and-loss ...), history in ink and the active case's
 * forecast in blue. A row named in a link (#revenue) is focused and highlighted on arrival. */
export default function StatementsPage({ parsed, doc, projection, sub, excel }: { parsed: Parsed; doc: ModelDoc; projection: Projection | null; sub: string; excel: ReactNode }) {
  const href = useHref()
  const { company, years: histYears, layout } = parsed
  const lender = parsed.kind === 'lender' || company.kind === 'lender'
  // a lender's ratios tab reads the drivers as they were (parsed.ratios) beside the reported lines
  const hist = lender ? company.hist.map((h, i) => ({ ...parsed.ratios[i], ...h })) : parsed.hist ?? company.hist
  const nHist = hist.length
  const n = doc.n, active = doc.active
  const proj = projection?.scenarios[active].length === n ? projection.scenarios[active] : null
  // older years with a P&L but no balance sheet (NSE's results before FY2023) open the table, marked P&L only
  const pl = company.pl_only ?? [], nPl = pl.length
  const years = [...pl.map(r => r.year), ...histYears, ...(proj ? projection!.years : [])]
  const rows: Row[] = [...pl, ...hist, ...(proj ?? [])]
  const quarterly: QuarterProps | null = company.quarters?.dates.length ? {
    quarters: company.quarters, ttm: parsed.ttm ?? null, ttmPrev: parsed.ttm_prev ?? null,
    year: histYears[nHist - 1], last: hist[nHist - 1], prev: nHist > 1 ? hist[nHist - 2] : null,
  } : null
  const tabs = STATEMENTS.filter(t => (t[0] !== 'quarters' || quarterly || sub === 'quarters') && !(lender && t[0] === 'cash-flow'))
  const cur = STATEMENTS.find(t => t[0] === sub) ?? STATEMENTS[0]
  const tab = cur[2] as string
  const moved = parsed.sources?.moved_out
  const hide = parsed.sources?.basis === 'cogs' ? undefined : new Set(['cogs'])
  // EPS per year: reported years on that year's share count where the export has it, the forecast on today's
  const sh = company.market?.shares_hist ?? [], now = projection?.valuation.shares ?? company.market?.shares ?? null
  const shares = rows.map((_, i) => (i < nPl ? null : i < nPl + nHist ? sh[i - nPl] ?? now : now))
  return (
    <>
      <PageHead label="Data · Statements" title={cur[1]}
        purpose={tab === 'QUARTERS'
          ? <>Last ten quarters as reported by {properName(parsed.company.name).replace(/\s+(ltd\.?|limited)$/i, '')}, the last full year, and <T k="ttm" />,
            with <T k="yoy" /> and QoQ growth.</>
          : tab === 'RATIOS' && lender ? <>The drivers as reported (loan growth, <T k="nim" />, <T k="cost_income" />, <T k="credit_cost" />…), returns, capital and asset quality,
            every year. Reported in black; forecast in blue, marked E.</>
          : tab === 'CASH FLOW' && lender ? <>Lenders aren’t modelled on cash flow: deposits and loans are the operating business.</>
          : tab === 'RATIOS' ? <>Margins, growth, returns, working-capital days, cash conversion and leverage, every year. Reported in black; forecast in blue, marked E.</>
          : <>Every line, every year. Reported in black; forecast in blue, marked E. Rs cr.</>}
        answer={tab === 'QUARTERS' ? (quarterly ? <>Quarters to {qfy(quarterly.quarters.dates[quarterly.quarters.dates.length - 1])}.</> : <>No quarterly data in this file.</>)
          : <>Reported {fy(nPl ? pl[0].year : histYears[0])}–{histYears[nHist - 1].slice(-2)}{nPl ? <> ({fy(pl[0].year)}–{pl[nPl - 1].year.slice(-2)} P&amp;L only)</> : null}{proj ? <>; {NAMES[active]}-case forecast to {fy(projection!.years[n - 1])}</> : null}.</>} />
      <nav className="stmt-tabs" aria-label="Statements">
        {tabs.map(([id, name]) => <a key={id} href={href('statements', '', id)} aria-current={id === cur[0] ? 'true' : undefined}>{name}</a>)}
      </nav>
      <label className="stmt-sel">Statement{' '}
        <select className="sel" value={cur[0]} onChange={e => navigate(href('statements', '', e.target.value))}>
          {tabs.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <section className="statements" aria-labelledby="page-h">
        {tab === 'QUARTERS'
          ? quarterly
            ? <div className="table-wrap" tabIndex={0} role="region" aria-label="Quarterly results"><QuarterTable {...quarterly} /></div>
            : <p className="val-empty">{lender ? 'Quarterly results aren’t modelled for banks and NBFCs yet.'
                : company.source ? `No quarterly results in the ${company.source.exchange} filings fetched. Refresh from ${company.source.exchange} once the next results are filed.`
                : 'No quarterly data in this Excel export. Exports with the Quarters block show the last ten quarters and TTM here.'}</p>
          : <StatementTable layout={layout} section={tab} years={years} rows={rows} nPl={nPl} nHist={nHist} hide={hide} shares={shares}
              cogs={parsed.sources?.basis === 'cogs'} lender={lender} />}
        {tab !== 'QUARTERS' && nPl > 0 && <p className="muted small">
          {fy(pl[0].year)}{nPl > 1 ? `–${fy(pl[nPl - 1].year)}` : ''}: P&amp;L from NSE’s annual results filings, which carry no
          balance sheet or cash flow in XBRL, so those lines are blank. These years fill the P&amp;L and the revenue <T k="cagr" /> track
          record only; the forecast defaults, ratios on the balance sheet and the forensic checks start at {fy(histYears[0])}.
          An Excel export fills them in full (<a href={href('documents', 'sources')}>Documents</a>).</p>}
        {tab === 'PROFIT & LOSS' && proj && moved?.year === histYears[nHist - 1] && <p className="guard small">
          Forecast base is Rs {money((hist[nHist - 1].revenue ?? 0) - moved.revenue_out)} cr, not the reported Rs {money(hist[nHist - 1].revenue ?? 0)} cr:
          Rs {money(moved.revenue_out)} cr of {histYears[nHist - 1]} revenue ({moved.reason || 'divested business'}) deconsolidated, so the step down
          into {projection!.years[0]} is deliberate. <a href={href('forecast', 'growth')}>Edit in Forecast</a></p>}
        {lender && tab !== 'RATIOS' && hist.some(h => h.provisions == null) && <p className="muted small">
          {fy(histYears[hist.findIndex(h => h.provisions == null)])}–{fy(histYears[nHist - 1 - [...hist].reverse().findIndex(h => h.provisions == null)])}{' '}
          come from the export: provisions sit inside operating expenses (PPOP blank) and advances include other assets. From the first filed
          year these are split as filed.</p>}
        {tab === 'RATIOS' && lender && <p className="muted small">
          NIM, fee income and the RoA tree on average total assets; credit cost on average advances; cost of funds on average deposits and
          borrowings. CET1 (forecast) = net worth ÷ RWA, with equity raised at year end below the floor. GNPA, NNPA and CET1 (or the CRAR some banks file in its place) as filed by the
          bank (not filed by NBFCs in XBRL). Excel-export years hold provisions inside operating expenses. – means not available.</p>}
        {tab === 'RATIOS' && !lender && (
          <p className="muted small">
            ROE = PAT ÷ average equity. ROCE = EBIT ÷ average (equity + borrowings + lease liabilities), EBIT = PBT +
            interest. Asset turnover = revenue ÷ average total assets. Averages use opening and closing balances; the
            first year uses closing. Days on year-end balances: debtor days on revenue, inventory and creditor days on
            {parsed.sources?.basis === 'cogs' ? ' COGS' : ' revenue'}. Net debt = borrowings + lease liabilities − cash − investments.
            – means not meaningful (zero or negative denominator).
          </p>
        )}
        {tab === 'QUARTERS' && quarterly && (
          <p className="muted small">
            As reported, last {Math.min(quarterly.quarters.dates.length, SHOW)} quarters (Indian FY, April–March). EBITDA = PBT + interest + depreciation −
            other income, as in the annual tables. TTM sums the last four quarters{quarterly.ttm ? ` to ${qfy(quarterly.ttm.end)}` : ''}.
            YoY: against the same quarter a year earlier (TTM: the four quarters before). QoQ: against the previous quarter.
            {!quarterly.ttm && ' No TTM here: the last four quarters in the file aren’t consecutive.'}
          </p>
        )}
      </section>
      <Next lead="Full model in Excel, with live formulas.">{excel}</Next>
    </>
  )
}

/** Row labels as an analyst writes them (the engine's LAYOUT labels stay as they are for the Excel sheet). */
const LABEL: Record<string, ReactNode> = {
  pat: <T k="pat" />, pbt: 'PBT', roe: <T k="roe" />, roce: <T k="roce" />, nd_ebitda: 'Net debt/EBITDA', int_cover: 'Interest cover',
  cfo: 'Cash from operations (CFO)', fcff: <T k="fcff" />, cwip: 'Capital WIP (CWIP)',
}
type Line = [label: ReactNode, key: string, kind: LineKind, get: (r: Row, i: number) => number | null | undefined]
const div = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && b > 0 ? a / b : null)
/** A multiple as brokers print it: net cash instead of a negative leverage, and a cap on a meaningless cover. */
function cell(key: string, v: number | null | undefined, kind: LineKind): string {
  if (v != null && Number.isFinite(v) && key === 'eps') return v.toFixed(2)
  if (v != null && key === 'nd_ebitda' && v < 0) return 'Net cash'
  if (v != null && key === 'int_cover' && v > 100) return '>100x'
  return fmt(v, kind)
}

function StatementTable({ layout, section, years, rows, nPl, nHist: nRep, hide, shares, cogs, lender }: {
  layout: LayoutLine[]; section: string; years: string[]; rows: Row[]; nPl: number; nHist: number; hide?: Set<string>
  shares: (number | null)[]; cogs: boolean; lender?: boolean
}) {
  let lines: Line[] = []
  let at = ''
  // a lender's ratios tab: its drivers, returns, capital and asset quality, each under its own head
  const sections = lender && section === 'RATIOS' ? ['ASSUMPTIONS', 'RATIOS', 'CAPITAL', 'ASSET QUALITY (reported)'] : [section]
  const HEADS: Record<string, string> = { ASSUMPTIONS: 'Drivers', RATIOS: 'Returns and funding', CAPITAL: 'Capital', 'ASSET QUALITY (reported)': 'Asset quality (reported)' }
  for (const [label, key, kind] of layout) {
    if (kind === 'head') { at = label; if (sections.length > 1 && sections.includes(label)) lines.push([HEADS[label], `h-${label}`, 'num', () => undefined]) }
    else if (key && sections.includes(at) && !hide?.has(key) && !(OPTIONAL.has(key) && rows.every(r => !r[key])))
      lines.push([(lender ? null : LABEL[key]) ?? label, key, kind as LineKind, r => r[key]])
  }
  // UI-only rows, from lines already here (no engine number changes)
  const eps = (i: number) => div(rows[i].pat, shares[i])
  const prev = (i: number, f: (j: number) => number | null | undefined) => (i ? div(f(i), f(i - 1)) : null)
  const yoy = (f: (j: number) => number | null | undefined) => (_: Row, i: number) => { const g = prev(i, f); return g == null ? null : g - 1 }
  if (section === 'PROFIT & LOSS') {
    const at = lines.findIndex(l => l[1] === 'pat') + 1
    lines.splice(at, 0, [<><T k="eps" /> (Rs)</>, 'eps', 'num', (_, i) => eps(i)])
  }
  if (section === 'RATIOS' && !lender) {
    const base = (r: Row) => (cogs ? r.cogs : r.revenue)
    const lead: Line[] = [
      [<T k="ebitda_margin" />, 'ebitda_margin', 'pct', r => div(r.ebitda, r.revenue)],
      ['PAT margin', 'pat_margin', 'pct', r => div(r.pat, r.revenue)],
      [<>Revenue <T k="yoy" /></>, 'rev_yoy', 'pct', yoy(j => rows[j].revenue)],
      [<>EPS <T k="yoy" /></>, 'eps_yoy', 'pct', yoy(eps)],
    ]
    const days: Line[] = [
      [<T k="dso" />, 'dso', 'days', r => div((r.receivables ?? 0) * 365, r.revenue)],
      [<T k="dio" />, 'dio', 'days', r => div((r.inventory ?? 0) * 365, base(r))],
      ...(rows.some(r => r.payables) ? [[<T k="dpo" />, 'dpo', 'days', (r: Row) => div((r.payables ?? 0) * 365, base(r))] as Line] : []),
      [<T k="cfo_pat" />, 'cfo_pat', 'x', r => div(r.cfo, r.pat)],
    ]
    const turn = lines.findIndex(l => l[1] === 'asset_turnover') + 1
    lines = [...lead, ...lines.slice(0, turn), ...days, ...lines.slice(turn)]
  }
  const nHist = nPl + nRep // reported columns, P&L-only ones first
  // opens at the first year; one button jumps to the latest
  const wrap = useRef<HTMLDivElement>(null)
  const jump = () => {
    const w = wrap.current, th = w?.querySelectorAll<HTMLElement>('thead tr:last-child th')
    if (w && th?.length) w.scrollTo({ left: Math.max(0, th[Math.max(1, nHist - 2)].offsetLeft - th[0].offsetWidth - 8), behavior: 'smooth' })
  }
  const nProj = years.length - nHist
  return (<>
    <p className="stmt-tools"><button type="button" className="btn" onClick={jump}>Jump to latest years →</button></p>
    <div className="table-wrap" ref={wrap} tabIndex={0} role="region" aria-labelledby="page-h">
      <table>
        <thead>
          <tr className="mark" aria-hidden="true"><td />
            {nPl > 0 && <td colSpan={nPl} className="pl-only">P&amp;L only</td>}<td colSpan={nRep}>Reported</td>{nProj > 0 && <td colSpan={nProj} className="proj">Forecast →</td>}</tr>
          <tr>
            <th scope="col">{section === 'RATIOS' ? 'Ratio' : 'Rs cr'}</th>
            {years.map((y, i) => <th scope="col" key={y} className={i >= nHist ? 'proj' : undefined}>{fy(i >= nHist && !y.endsWith('E') ? `${y}E` : y)}</th>)}
          </tr>
        </thead>
        <tbody>
          {lines.map(([label, key, kind, get]) => key.startsWith('h-')
            ? <tr key={key} className="sub-h"><th scope="rowgroup" colSpan={rows.length + 1}>{label}</th></tr>
            : (
            <tr key={key} id={key} tabIndex={-1} className={TOTALS.has(key) ? 'total' : undefined}>
              <th scope="row">{label}</th>
              {rows.map((r, i) => {
                const v = get(r, i)
                return <td key={years[i]} className={i >= nHist ? 'proj' : i < nPl ? 'pl-only' : undefined}>{cell(key, v, kind)}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </>)
}

const SHOW = 10 // an export has ten quarters
const DAY = 86_400_000
/** a / b - 1, blank when the base isn't positive (growth off a loss means nothing) */
export const growth = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && b > 0 ? a / b - 1 : null
const margin = (op: number | null | undefined, sales: number | null | undefined) =>
  op != null && sales ? op / sales : null

/** Last ten quarters in ink, then the last reported year and TTM, so the run rate sits next to the annual figure. */
function QuarterTable({ quarters, ttm, ttmPrev, year, last, prev }: QuarterProps) {
  const { dates, rows: q } = quarters
  const from = Math.max(0, dates.length - SHOW)
  const idx = dates.map((_, i) => i).slice(from)
  // same quarter a year earlier: four back, and really ~365 days back (a missing quarter shifts the index)
  const yearAgo = (i: number) =>
    i >= 4 && Math.abs((Date.parse(dates[i]) - Date.parse(dates[i - 4])) / DAY - 365) <= 15 ? i - 4 : -1
  // the previous quarter: one back, and really ~91 days back
  const qAgo = (i: number) => (i >= 1 && Math.abs((Date.parse(dates[i]) - Date.parse(dates[i - 1])) / DAY - 91) <= 15 ? i - 1 : -1)
  const at = (k: string, i: number) => (i < 0 ? null : q[k]?.[i] ?? null)
  const t = ttm?.values, tp = ttmPrev?.values
  const lines: [string, LineKind, (i: number) => number | null, number | null, number | null][] = [
    // label, kind, quarter i, last FY, TTM
    ['Revenue', 'num', i => at('sales', i), last.revenue, t?.sales ?? null],
    ['EBITDA', 'num', i => at('op_profit', i), last.ebitda, t?.op_profit ?? null],
    ['EBITDA margin', 'pct', i => margin(at('op_profit', i), at('sales', i)), margin(last.ebitda, last.revenue),
      margin(t?.op_profit, t?.sales)],
    ['PAT', 'num', i => at('net_profit', i), last.pat, t?.net_profit ?? null],
    ['Revenue YoY', 'pct', i => growth(at('sales', i), at('sales', yearAgo(i))),
      growth(last.revenue, prev?.revenue), growth(t?.sales, tp?.sales)],
    ['Revenue QoQ', 'pct', i => growth(at('sales', i), at('sales', qAgo(i))), null, null],
    ['PAT YoY', 'pct', i => growth(at('net_profit', i), at('net_profit', yearAgo(i))),
      growth(last.pat, prev?.pat), growth(t?.net_profit, tp?.net_profit)],
    ['PAT QoQ', 'pct', i => growth(at('net_profit', i), at('net_profit', qAgo(i))), null, null],
  ]
  return (
    <table className="q-table">
      <thead>
        <tr>
          <th scope="col">Rs cr</th>
          {idx.map(i => <th scope="col" key={dates[i]}>{qfy(dates[i])}</th>)}
          <th scope="col" className="q-sum">{fy(year)}</th>
          {ttm && <th scope="col" className="q-sum"><T k="ttm" /> {qfy(ttm.end)}</th>}
        </tr>
      </thead>
      <tbody>
        {lines.map(([label, kind, f, fyv, tv]) => (
          <tr key={label} className={label === 'PAT' ? 'total' : undefined}>
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
