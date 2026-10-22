import type { ReactNode } from 'react'
import { useWidth } from './Ruler'
import { More, Next, PageHead, Sev } from './Shell'
import { useHref } from './route'
import { forecastOf } from './Tracking'
import { fmt, money, properName, fy, type ArNote, type Forensic, type Parsed, type Row, type Tracking } from './lib'

/** Financials: what the company reported, before any forecast. Everything here derives from the parsed history
 * (parsed.hist, parsed.ratios) and the forensic radar's lit flags; nothing is computed on the server for it. */

type S = (number | null)[]
const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x)
const pc = (x: number | null | undefined) => fmt(x, 'pct')
const xx = (x: number | null | undefined) => (fin(x) ? `${x.toFixed(2)}x` : '–')
/** Compound growth over the last k years; null when either end is missing or not positive. */
export const cagrOf = (v: S, k: number) => {
  const n = v.length, a = v[n - 1 - k], b = v[n - 1]
  return k >= 1 && n - 1 >= k && fin(a) && fin(b) && a > 0 && b > 0 ? (b / a) ** (1 / k) - 1 : null
}
export const med = (v: S) => {
  const s = v.filter(fin).sort((a, b) => a - b), m = s.length >> 1
  return !s.length ? null : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const sum = (v: S) => v.reduce<number>((a, b) => a + (b ?? 0), 0)
const div = (a: number | null | undefined, b: number | null | undefined) => (fin(a) && fin(b) && b !== 0 ? a / b : null)
const netCash = (h: Row) => (fin(h.cash) || fin(h.investments) || fin(h.borrowings)
  ? (h.cash ?? 0) + (h.investments ?? 0) - (h.borrowings ?? 0) - (h.lease ?? 0) : null)

/** The series every view of the fundamentals reads, built once from the history. */
function series(parsed: Parsed) {
  const hist = parsed.hist ?? parsed.company.hist, years = parsed.years, n = hist.length
  const col = (k: string) => hist.map(h => h[k] ?? null)
  const revenue = col('revenue'), ebitda = col('ebitda'), pat = col('pat'), cfo = col('cfo')
  const margin = hist.map(h => div(h.ebitda, h.revenue))
  const lit = (key: string) => (parsed.forensic ?? []).find(f => f.key === key && ['high', 'medium', 'low'].includes(f.severity)) ?? null
  const k5 = Math.min(5, n), conv5 = div(sum(cfo.slice(-k5)), sum(pat.slice(-k5)))
  return { hist, years, n, col, revenue, ebitda, pat, cfo, margin, lit, k5, conv5, long: Math.min(10, n - 1) }
}

interface Line { v: S; cls?: 'alt' | 'out' | 'flag'; name?: string }
/** A small chart drawn at its real width: bars (one or two series side by side) or lines from zero, an optional dashed
 * median, every year's value in the accessible name. */
export function Plot({ years, lines, kind, show, refLine, label, neg, marks }: {
  years: string[]; lines: Line[]; kind: 'bars' | 'lines'; show: (x: number) => string; refLine?: number | null; label: string; neg?: boolean
  marks?: S // pencil ticks: what you forecast for a year before it was reported (5.3)
}) {
  const [box, w] = useWidth<HTMLDivElement>(420)
  const H = 150, L = 6, R = 6, T = 18, B = 20, n = years.length
  const all = [...lines.flatMap(l => l.v), ...(marks ?? [])].filter(fin)
  const hi0 = Math.max(0, ...all), lo = Math.min(0, ...all)
  const hi = kind === 'lines' ? hi0 + (hi0 - lo) * 0.14 : hi0
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B)
  const band = (w - L - R) / n, x = (i: number) => L + (i + 0.5) * band
  const every = Math.ceil(36 / band)
  const name = `${label}: ${years.map((yr, i) => `${yr} ${lines.map(l => (fin(l.v[i]) ? show(l.v[i]!) : 'none')).join(' and ')}${fin(marks?.[i]) ? ` (you forecast ${show(marks![i]!)})` : ''}`).join(', ')}`
  const lastV = lines[0].v[n - 1]
  const lift = fin(marks?.[n - 1]) ? y(marks![n - 1]!) - 4 : Infinity // the last value's label sits above a pencil tick
  return (
    <div className="plot" ref={box}>
      {all.length === 0 ? <p className="small dim">Not in this export.</p> :
      <svg width={w} height={H} role="img" aria-label={name}>
        <line className="ax" x1={L} x2={w - R} y1={y(0)} y2={y(0)} />
        {refLine != null && <g><line className="ref" x1={L} x2={w - R} y1={y(refLine)} y2={y(refLine)} />
          <text className="tx" x={L + 2} y={y(refLine) - 4} textAnchor="start">median {show(refLine)}</text></g>}
        {kind === 'bars' && lines.map((l, j) => l.v.map((v, i) => {
          if (!fin(v)) return null
          const wide = lines.length > 1 ? band * 0.34 : band * 0.62
          const x0 = lines.length > 1 ? L + i * band + band * (j ? 0.52 : 0.14) : x(i) - wide / 2
          return <rect key={`${j}-${i}`} className={`${l.cls === 'out' ? 'b2' : 'b'}${neg && v < 0 ? ' neg' : ''}`} x={x0} width={wide}
            y={Math.min(y(v), y(0))} height={Math.max(1, Math.abs(y(v) - y(0)))} />
        }))}
        {kind === 'lines' && lines.map((l, j) => {
          const pts = l.v.map((v, i) => (fin(v) ? [x(i), y(v)] : null)).filter((p): p is number[] => p != null)
          return <g key={j} className={l.cls}>
            <polyline className="ln" points={pts.map(p => p.join(',')).join(' ')} />
            {pts.map((p, i) => <circle key={i} className="dt" cx={p[0]} cy={p[1]} r="2.4" />)}
            {fin(l.v[n - 1]) && <text className="tv" x={x(n - 1)} y={j ? y(l.v[n - 1]!) + 14 : Math.min(y(l.v[n - 1]!), lift) - 7} textAnchor="end">{show(l.v[n - 1]!)}</text>}
          </g>
        })}
        {kind === 'bars' && lines.length === 1 && fin(lastV) && <text className="tv" x={x(n - 1)} textAnchor="end"
          y={lastV >= 0 ? Math.min(y(lastV), lift) - 5 : y(0) - 5}>{show(lastV)}</text>}
        {marks?.map((v, i) => fin(v) && <g key={`f${i}`} className="fc">
          <line className="fc-halo" x1={x(i) - band * 0.42} x2={x(i) + band * 0.42} y1={y(v)} y2={y(v)} />
          <line className="fc-mark" x1={x(i) - band * 0.42} x2={x(i) + band * 0.42} y1={y(v)} y2={y(v)} /></g>)}
        {years.map((yr, i) => ((n - 1 - i) % every ? null : <text key={yr} className="tx" x={x(i)} y={H - 5} textAnchor="middle">{fy(yr)}</text>))}
      </svg>}
      {lines.length > 1 && <p className="key2" aria-hidden="true">{lines.map(l => <span key={l.name}><i className={`k-${l.cls ?? 'ink'}`} />{l.name}</span>)}</p>}
    </div>
  )
}

export default function Fundamentals({ parsed, tracking, notes, hasAnnual }: { parsed: Parsed; tracking?: Tracking | null; notes: Record<string, unknown>; hasAnnual: boolean }) {
  const href = useHref()
  const f = series(parsed)
  const { hist, years, n, col, revenue, pat, cfo, margin, long } = f
  const short = properName(parsed.company.name).replace(/\s+(ltd\.?|limited)$/i, '').trim()
  const last = fy(years[n - 1]), first = fy(years[0]) // display labels (FY26)
  const ratios = parsed.ratios
  const dso = ratios.map(r => r.dso ?? null)
  const nc = hist.map(netCash)
  const roce = col('roce'), roe = col('roe'), fcf = col('fcf'), dividend = col('dividend')
  const dsoLit = f.lit('dso'), cashLit = f.lit('cash') ?? f.lit('cash5'), debtLit = f.lit('debt')
  const st = (sub: string, key: string) => href('statements', key, sub)
  const PL = 'profit-and-loss', BS = 'balance-sheet', CF = 'cash-flow', RT = 'ratios'

  // growth: 3, 5 and 10 years where the history reaches; ochre when slower than the longest period
  const spans = [3, 5, 10].filter(k => k <= n - 1)
  if (!spans.length && n > 1) spans.push(n - 1)
  const top = spans[spans.length - 1]
  const growthRows: [string, S][] = [['Revenue', revenue], ['EBITDA', f.ebitda], ['PAT', pat], ['CFO', cfo]]

  const mx = margin.filter(fin), g = cagrOf(revenue, long), g3 = cagrOf(revenue, Math.min(3, long)), gp = cagrOf(pat, long)
  const payout5 = div(sum(dividend.slice(-5)), sum(fcf.slice(-5)))
  const pos = nc.filter(x => fin(x) && x >= 0).length, ncN = nc.filter(fin).length
  const dsoNow = dso[n - 1], dsoThen = n > 3 ? dso[n - 4] : null
  // what you forecast for years that are now reported (the newest forecast for each), as pencil ticks
  const fRev = forecastOf(tracking, 'revenue'), fEb = forecastOf(tracking, 'ebitda'), fPat = forecastOf(tracking, 'pat')
  const fc = (m: Record<string, number>) => (Object.keys(m).length ? years.map(y => m[y] ?? null) : undefined)
  const fYears = Object.keys(fRev)
  const fMargin = fc(Object.fromEntries(fYears.filter(y => fEb[y] != null && fRev[y]).map(y => [y, fEb[y] / fRev[y]])))
  const cards: { id: string; title: string; big: string; says: ReactNode; chart: ReactNode; to: string; table: string; lit?: Forensic | null }[] = [
    { id: 'revenue', title: 'Revenue', big: `Rs ${money(revenue[n - 1])} cr`, to: st(PL, 'revenue'), table: 'P&L',
      says: g != null ? <>{long}-year CAGR {pc(g)}{long > 3 && g3 != null ? <>; 3-year {pc(g3)}</> : null}.</> : <>As reported.</>,
      chart: <Plot years={years} kind="bars" lines={[{ v: revenue }]} show={money} label="Revenue by year, Rs cr" marks={fc(fRev)} /> },
    { id: 'margin', title: 'EBITDA margin', big: pc(margin[n - 1]), to: st(PL, 'ebitda'), table: 'P&L',
      says: <>EBITDA ÷ revenue{mx.length ? <>; {mx.length}-year range {pc(Math.min(...mx))}–{pc(Math.max(...mx))}</> : null}.</>,
      chart: <Plot years={years} kind="lines" lines={[{ v: margin }]} show={pc} refLine={med(margin)} label="EBITDA margin by year" marks={fMargin} /> },
    { id: 'profit', title: 'PAT', big: `Rs ${money(pat[n - 1])} cr`, to: st(PL, 'pat'), table: 'P&L',
      says: <>{gp != null ? <>{long}-year CAGR {pc(gp)}. </> : null}{last} PAT margin {pc(div(pat[n - 1], revenue[n - 1]))}.</>,
      chart: <Plot years={years} kind="bars" lines={[{ v: pat }]} show={money} neg label="PAT by year, Rs cr" marks={fc(fPat)} /> },
    { id: 'cash', title: 'Cash conversion (CFO/PAT)', big: xx(f.conv5), to: st(CF, 'cfo'), table: 'Cash flow', lit: cashLit,
      says: f.conv5 == null ? <>No operating cash flow in the export.</>
        : <>Cumulative {f.k5}-year CFO/PAT {xx(f.conv5)}: {f.conv5 >= 0.9 ? 'strong' : f.conv5 >= 0.8 ? 'adequate' : 'weak'} cash conversion.</>,
      chart: <Plot years={years} kind="bars" lines={[{ v: pat, name: 'PAT' }, { v: cfo, cls: 'out', name: 'CFO' }]} show={money} label="PAT and CFO by year, Rs cr" /> },
    { id: 'returns', title: 'ROCE and ROE', big: pc(roce[n - 1]), to: st(RT, 'roce'), table: 'Ratios',
      says: <>ROCE = EBIT ÷ average capital employed; ROE = PAT ÷ average equity.</>,
      chart: <Plot years={years} kind="lines" lines={[{ v: roce, name: 'ROCE' }, { v: roe, cls: 'alt', name: 'ROE' }]} show={x => fmt(x, 'pct')} label="ROCE and ROE by year" /> },
    { id: 'fcf', title: 'FCF and dividends', big: `Rs ${money(fcf[n - 1])} cr`, to: st(CF, 'fcf'), table: 'Cash flow',
      says: <>FCF = CFO − capex.{payout5 != null && payout5 > 0 ? <> 5-year dividends ÷ FCF: {pc(payout5)}.</> : null}</>,
      chart: <Plot years={years} kind="bars" neg lines={[{ v: fcf, name: 'FCF' }, { v: dividend, cls: 'out', name: 'Dividends' }]} show={money} label="FCF and dividends by year, Rs cr" /> },
    { id: 'receivables', title: 'Debtor days', big: fin(dsoNow) ? `${Math.round(dsoNow)} days` : '–', to: st(BS, 'receivables'), table: 'Balance sheet', lit: dsoLit,
      says: <>Receivables ÷ revenue × 365{fin(dsoThen) && fin(dsoNow) ? <>: {Math.round(dsoThen)} in {fy(years[n - 4])}, {Math.round(dsoNow)} in {last}</> : null}.{dsoLit ? ' Flagged by a forensic rule.' : ''}</>,
      chart: <Plot years={years} kind="lines" lines={[{ v: dso, cls: dsoLit && dsoLit.severity !== 'low' ? 'flag' : undefined }]} show={x => String(Math.round(x))} refLine={med(dso)} label="Debtor days by year" /> },
    { id: 'netcash', title: nc[n - 1] != null && nc[n - 1]! < 0 ? 'Net debt' : 'Net cash', big: `Rs ${money(nc[n - 1])} cr`, to: st(BS, 'cash'), table: 'Balance sheet', lit: debtLit,
      says: <>Cash + investments − borrowings{hist.some(h => h.lease) ? ' incl. leases' : ''}. {ncN ? (pos === ncN ? 'Net cash in every year.' : pos === 0 ? 'Net debt in every year.' : `Net cash in ${pos} of ${ncN} years.`) : ''}</>,
      chart: <Plot years={years} kind="bars" neg lines={[{ v: nc }]} show={money} label="Net cash/(debt) by year, Rs cr" /> },
  ]

  // key ratios: the last ten years and their median; each name opens the line it comes from
  const from = Math.max(0, n - 10), shownYears = years.slice(from)
  const R: [string, S, (x: number) => string, string, boolean?][] = [
    ['Revenue growth', ratios.map(r => r.growth ?? null), pc, st(PL, 'revenue')],
    ['EBITDA margin', margin, pc, st(PL, 'ebitda')],
    ['PAT margin', hist.map(h => div(h.pat, h.revenue)), pc, st(PL, 'pat')],
    ['ROCE', roce, pc, st(RT, 'roce')],
    ['ROE', roe, pc, st(RT, 'roe')],
    ['CFO/PAT', hist.map(h => (fin(h.pat) && h.pat > 0 ? div(h.cfo, h.pat) : null)), x => x.toFixed(2) + 'x', st(CF, 'cfo')],
    ['Debtor days', dso, x => String(Math.round(x)), st(BS, 'receivables'), !!dsoLit],
    ['Asset turnover', col('asset_turnover'), x => x.toFixed(2) + 'x', st(RT, 'asset_turnover')],
    ['Dividend payout', ratios.map(r => r.payout ?? null), pc, st(PL, 'dividend')],
    ['Net debt/EBITDA', col('nd_ebitda'), x => x.toFixed(1) + 'x', st(RT, 'nd_ebitda')],
    ['Interest cover', col('int_cover'), x => x.toFixed(0) + 'x', st(RT, 'int_cover')],
  ]

  const shown = cards.filter((c, i) => i < 6 || c.lit), more = cards.filter((c, i) => i >= 6 && !c.lit)
  const chart = (c: typeof cards[number]) => (
    <article key={c.id} id={`f-${c.id}`} tabIndex={-1} className={`fcard${c.lit ? ` lit s-${c.lit.severity}` : ''}`} aria-labelledby={`fh-${c.id}`}>
      <header><h3 id={`fh-${c.id}`}>{c.title}</h3><span className="big">{c.big}</span></header>
      <p className="says">{c.says}</p>
      {c.chart}
      <footer><span>{c.lit ? <><Sev level={c.lit.severity} /> {c.lit.fact}</> : `${first}–${last.slice(-2)}`}</span>
        <a className="go" href={c.to}>{c.table} table</a></footer>
    </article>
  )
  // the answer, by rules: the last three years' revenue CAGR against the longest period, and whether it's the slowest run
  const r3 = parsed.cagrs?.['3'] ?? []
  const slowest = r3.length > 2 && g3 != null && r3.every(c => c.value >= r3[r3.length - 1].value - 1e-9)
  const story = g3 == null ? <>Too few positive years to compute revenue CAGR.</>
    : <>3-year revenue CAGR {pc(g3)}{slowest ? `, the slowest 3-year run since ${first}` : g != null && long > 3 ? ` vs ${pc(g)} over ${long} years (${g3 < g - 0.01 ? 'decelerating' : g3 > g + 0.01 ? 'accelerating' : 'steady'})` : ''}.
      {mx.length > 0 && <> {last} EBITDA margin {pc(margin[n - 1])} (range {pc(Math.min(...mx))}–{pc(Math.max(...mx))}).</>}</>

  return (
    <>
      <PageHead label="Data · Financials" title="Financials"
        purpose={<>{n}-year reported fundamentals for {short} ({first}–{last.slice(-2)}), before any forecast. Each chart links to its
          statement line.</>}
        answer={story} />

      <section className="blk first" id="growth" aria-labelledby="growth-h">
        <h2 id="growth-h">CAGR</h2>
        <p className="why">Compound annual growth to {last}. “▾ slower”: below the {top}-year CAGR.</p>
        <div className="tw-m" tabIndex={0} role="region" aria-labelledby="growth-h">
          <table className="growth">
            <thead><tr><th scope="col">Rs cr</th>{spans.map(k => <th scope="col" key={k}>{k}Y</th>)}</tr></thead>
            <tbody>{growthRows.map(([name, v]) => {
              const ref = cagrOf(v, top)
              return <tr key={name}><th scope="row">{name}</th>{spans.map(k => {
                const c = cagrOf(v, k), slow = k < top && c != null && ref != null && c < ref - 0.01
                return <td key={k} className={`num${slow ? ' slow' : ''}`}>{pc(c)}{slow && <span className="slow-w"> ▾ slower</span>}</td>
              })}</tr>
            })}</tbody>
          </table>
        </div>
      </section>

      <section className="blk" id="charts" aria-labelledby="charts-h">
        <h2 id="charts-h">{n}-year trends</h2>
        <p className="why">Black: reported. Each chart links to its statement line.{fYears.length > 0 && <>
          {' '}<span className="fc-key" aria-hidden="true" /> Blue ticks on revenue, margin and PAT: the forecast for {fYears.join(', ')} made before
          reporting (<a href={href('tracking', 'by-input')}>variance</a>).</>}</p>
        <div className="fgrid">{shown.map(chart)}</div>
        {more.length > 0 && <More title="More charts" n={more.length}><div className="fgrid">{more.map(chart)}</div></More>}
      </section>

      <section className="blk" id="ratios" aria-labelledby="ratios-h">
        <h2 id="ratios-h">Key ratios</h2>
        <p className="why">Last column: median over these years. Each row links to its statement line.</p>
        <div className="tw" tabIndex={0} role="region" aria-labelledby="ratios-h">
          <table className="rt">
            <thead><tr><td />{shownYears.map(y => <th scope="col" key={y}>{y}</th>)}<th scope="col" className="med">Median</th></tr></thead>
            <tbody>{R.map(([name, v, show, to, lit]) => {
              const xs = v.slice(from), m = med(xs)
              return <tr key={name} className={lit ? 'lit' : undefined}><th scope="row"><a href={to}>{name}</a></th>
                {xs.map((x, i) => <td key={i}>{fin(x) ? show(x) : '–'}</td>)}<td className="med">{m == null ? '–' : show(m)}</td></tr>
            })}</tbody>
          </table>
        </div>
      </section>

      <OperatingNumbers notes={notes} hasAnnual={hasAnnual} />

      <Next lead="Full reported P&L, balance sheet and cash flow."><a className="primary" href={href('statements')}>Statements</a></Next>
    </>
  )
}

/** Operating numbers from the latest approved annual-report note (order book, headcount, attrition, volumes...), each in
 * the unit printed, with its quote. Read by AI, checked by rules, approved by you; they never feed a number. */
function OperatingNumbers({ notes, hasAnnual }: { notes: Record<string, unknown>; hasAnnual: boolean }) {
  const href = useHref()
  const n = Object.entries(notes).filter(([k]) => k.startsWith('ar:kpis:')).map(([, x]) => x as ArNote)
    .sort((a, b) => b.year.localeCompare(a.year))[0]
  return (
    <section className="blk" id="kpis" aria-labelledby="kpis-h">
      <h2 id="kpis-h">Operating KPIs</h2>
      {n ? <>
        <p className="why">{n.year}, as printed in {n.file ?? 'the annual report'}: AI-read, rule-checked, approved by you. Not used in the model.</p>
        <ul className="kpi-list">{n.rows.map((r, i) => (
          <li key={i}><span>{r.label}</span> <b className="num">{r.amount == null ? '–' : r.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}{r.unit === '%' ? '%' : ` ${r.unit ?? ''}`}</b>
            <span className="small dim"> p.{r.page}<span className="sr">: “{r.quote}”</span></span></li>))}</ul>
      </> : <p className="why">Order book, headcount, attrition or volumes from the annual report. None read yet: {hasAnnual
        ? <>the report is attached; <a href={href('documents', 'reading')}>have AI read “Operating numbers”</a> from it.</>
        : <>attach the report on <a href={href('documents', 'add')}>Documents</a> and have AI read “Operating numbers”.</>}</p>}
    </section>
  )
}
