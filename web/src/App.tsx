import { useEffect, useMemo, useRef, useState } from 'react'
import Chart from './Chart'
import DriverStrip from './DriverStrip'
import Statements from './Statements'
import { api, fmt, groupKeys, money, postJson, type Parsed, type Projection, type Row } from './lib'

const GROUPS: [string, string[]][] = [
  ['Growth and margins', ['growth', 'ebitda_margin', 'oi_pct']],
  ['Investment', ['capex_pct', 'dep_pct']],
  ['Working capital', ['dso', 'dio', 'oca_pct', 'ol_pct']],
  ['Financing and tax', ['debt_change', 'int_rate', 'tax_rate', 'mi_pct', 'payout']],
]
const HINTS: Record<string, string> = {
  growth: 'Change in sales vs the year before',
  ebitda_margin: 'Operating profit before depreciation, share of sales',
  oi_pct: 'Treasury and non-operating income, share of sales',
  capex_pct: 'Spend on new fixed assets, share of sales',
  dep_pct: 'Share of last year’s net block written off',
  dso: 'Days of sales waiting to be collected',
  dio: 'Days of sales held as stock',
  oca_pct: 'Advances, deposits and other current assets',
  ol_pct: 'Payables, provisions and other liabilities',
  debt_change: 'Net new debt you plan each year. Shortfalls are borrowed automatically',
  int_rate: 'Interest as share of last year’s borrowings',
  tax_rate: 'Tax as share of profit before tax',
  mi_pct: 'Associates’ profit added, minority holders’ share taken out',
  payout: 'Share of net profit paid as dividend',
}
const METRICS: [string, string, (r: Row) => number | null][] = [
  ['revenue', 'Revenue', r => r.revenue],
  ['ebitda', 'EBITDA', r => r.ebitda],
  ['pat', 'Net profit', r => r.pat],
  ['fcf', 'Free cash flow', r => r.fcf],
  ['net_cash', 'Net cash', r => (r.cash ?? 0) + (r.investments ?? 0) - (r.borrowings ?? 0)],
]
const HORIZONS = [3, 5, 7, 10]
const STORE = 'financial-model:v2' // bump when the saved shape or the driver list changes

interface Saved { parsed: Parsed; a: Record<string, number>; n: number }

/** Last session, or null if missing, corrupt, or saved by an older version of the app. */
function load(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null')
    const keys: string[] = s?.parsed?.drivers?.map((d: unknown[]) => d[0]) ?? []
    const ok = s?.parsed?.company?.hist?.length && s.parsed.years?.length && s.parsed.layout?.length &&
      keys.length && keys.every(k => Number.isFinite(s.a?.[k]) && Number.isFinite(s.parsed.defaults?.[k])) &&
      HORIZONS.includes(s.n)
    return ok ? s : null
  } catch { return null }
}

export default function App() {
  const saved = useMemo(load, [])
  const [parsed, setParsed] = useState<Parsed | null>(saved?.parsed ?? null)
  const [a, setA] = useState<Record<string, number>>(saved?.a ?? {})
  const [n, setN] = useState(saved?.n ?? 5)

  const open = (p: Parsed) => { setParsed(p); setA(p.defaults); setN(5) }
  const close = () => { setParsed(null); try { localStorage.removeItem(STORE) } catch { /* private mode */ } }

  useEffect(() => {
    if (!parsed) return
    try { localStorage.setItem(STORE, JSON.stringify({ parsed, a, n })) } catch { /* quota / private mode */ }
  }, [parsed, a, n])

  return parsed
    ? <Workspace parsed={parsed} a={a} setA={setA} n={n} setN={setN} onClose={close} />
    : <Landing onOpen={open} />
}

function Landing({ onOpen }: { onOpen: (p: Parsed) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const run = async (label: string, req: () => Promise<Parsed>) => {
    if (busy) return // one load at a time, so a slow earlier upload can't replace a later one
    setBusy(label)
    setError(null)
    try { onOpen(await req()) } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const upload = (f: File | undefined) => {
    if (!f) return
    const body = new FormData()
    body.append('file', f)
    run(`Reading ${f.name}…`, () => api<Parsed>('/api/parse', { method: 'POST', body }))
  }

  return (
    <main className="landing">
      <p className="wordmark">Financial model</p>
      <h1>Turn a company’s reported numbers into a forecast you can steer.</h1>
      <p className="lede">
        Reported years come in <span className="ink-word">ink</span>. You set the future in{' '}
        <span className="pencil-word">pencil</span>, then take it away as a live Excel model.
      </p>

      <label
        className={`drop ${over ? 'is-over' : ''}`}
        aria-busy={!!busy}
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]) }}
      >
        <input ref={input} type="file" accept=".xlsx" className="visually-hidden" disabled={!!busy}
          onChange={e => { upload(e.target.files?.[0]); e.target.value = '' }} />
        <span className="drop-title">{busy ?? 'Drop a Export.in export here'}</span>
        {!busy && <span className="drop-sub">or <u>choose a file</u> (.xlsx)</span>}
      </label>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="how">
        <h2>Getting the file</h2>
        <ol>
          <li>Open the company on <a href="https://www.export.in" target="_blank" rel="noreferrer">export.in</a>.</li>
          <li>Click <b>Export to Excel</b>. A free account is needed.</li>
          <li>Drop the downloaded file above.</li>
        </ol>
        <button type="button" className="link" disabled={!!busy}
          onClick={() => run('Loading sample…', () => api<Parsed>('/api/sample'))}>
          Explore with a sample company
        </button>
        <span className="muted"> (made-up numbers)</span>
      </div>
      <p className="scope muted">Works for manufacturing, services and other non-financial companies. Banks, NBFCs and insurers aren’t supported yet.</p>
    </main>
  )
}

interface WorkspaceProps {
  parsed: Parsed
  a: Record<string, number>
  setA: React.Dispatch<React.SetStateAction<Record<string, number>>>
  n: number
  setN: (n: number) => void
  onClose: () => void
}

function Workspace({ parsed, a, setA, n, setN, onClose }: WorkspaceProps) {
  const { company, years: histYears, ratios, defaults, checks, drivers, layout } = parsed
  const [projection, setProjection] = useState<Projection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [metric, setMetric] = useState(METRICS[0][0])
  const [showChecks, setShowChecks] = useState(false)
  const [exporting, setExporting] = useState(false)
  const hist = company.hist
  const nHist = hist.length

  useEffect(() => {
    const ctl = new AbortController()
    api<Projection>('/api/project', postJson({ company, a, n }, ctl.signal))
      .then(p => { setProjection(p); setError(null) })
      .catch(e => { if (e.name !== 'AbortError') { setProjection(null); setError(e.message) } })
    return () => ctl.abort()
  }, [company, a, n])

  const proj = projection?.proj.length === n ? projection.proj : null // null while a new horizon loads
  const projYears = proj ? projection!.years : []
  const years = [...histYears, ...projYears]
  const rows = proj ? [...hist, ...proj] : hist

  const exportXlsx = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/export', postJson({ company, a, n }))
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? 'Export failed. Try again.')
      const url = URL.createObjectURL(await res.blob())
      const link = Object.assign(document.createElement('a'), { href: url, download: `${company.name} model.xlsx` })
      link.click()
      URL.revokeObjectURL(url)
    } catch (e) { setError((e as Error).message) } finally { setExporting(false) }
  }

  const byKey = Object.fromEntries(drivers.map(d => [d[0], d]))
  const balanced = proj?.every(r => Math.abs(r.chk_bs ?? 0) < 0.5 && Math.abs(r.chk_cash ?? 0) < 0.5)
  const borrowed = proj ? proj.reduce((s, r) => s + (r.revolver ?? 0), 0) : 0
  const m = METRICS.find(x => x[0] === metric)!

  return (
    <div className="workspace">
      <div className="head-area">
      <header className="top">
        <div className="title">
          <button type="button" className="link back" onClick={onClose}>Open another file</button>
          <h1>{company.name}</h1>
          <p className="muted">
            Rs crore · <span className="ink-word">{histYears[0]}–{histYears[nHist - 1]} reported</span>
            {proj && <> · <span className="pencil-word">{projYears[0]}–{projYears[n - 1]} projected</span></>}
          </p>
        </div>
        <div className="actions">
          <div className="segmented" role="radiogroup" aria-label="Years to project">
            {HORIZONS.map(h => (
              <button key={h} type="button" role="radio" aria-checked={n === h} tabIndex={n === h ? 0 : -1}
                onClick={() => setN(h)} onKeyDown={e => groupKeys(e, HORIZONS, n, setN)}>{h} yrs</button>
            ))}
          </div>
          <button type="button" className="primary" onClick={exportXlsx} disabled={!proj || exporting}>
            {exporting ? 'Exporting…' : 'Export to Excel'}
          </button>
        </div>
      </header>

      <div className="status" aria-live="polite">
        {balanced && <span className="ok">Balance sheet balances in every projected year</span>}
        {checks.length > 0 && (
          <button type="button" className="warn" onClick={() => setShowChecks(s => !s)} aria-expanded={showChecks}>
            {checks.length} issue{checks.length > 1 ? 's' : ''} in the reported data
          </button>
        )}
        {error && <span className="bad" role="alert">{error}</span>}
      </div>
      {showChecks && <ul className="check-list">{checks.map(c => <li key={c}>{c}</li>)}</ul>}
      </div>

      <aside className="drivers" aria-label="Assumptions">
        <div className="drivers-head">
          <h2>Assumptions</h2>
          <button type="button" className="link" onClick={() => setA(defaults)}>Reset all</button>
        </div>
        <p className="muted small">Dots are reported years. Drag the pencil line, use arrow keys, or type a value.</p>
        {GROUPS.map(([group, keys]) => (
          <section key={group} className="group">
            <h3>{group}</h3>
            {keys.filter(k => byKey[k]).map(k => (
              <DriverStrip
                key={`${company.name}-${k}`}
                id={k}
                label={byKey[k][1]}
                hint={HINTS[k] ?? ''}
                kind={byKey[k][2]}
                history={ratios.map(r => r[k])}
                value={a[k] ?? defaults[k]}
                base={defaults[k]}
                baseLabel={k === 'debt_change' ? 'no new debt' : `default ${fmt(defaults[k], byKey[k][2])}`}
                onChange={v => setA(prev => ({ ...prev, [k]: v }))}
              />
            ))}
          </section>
        ))}
      </aside>

      <main className="main">
        {proj && <Readout hist={hist} proj={proj} histYear={histYears[nHist - 1]} projYear={projYears[n - 1]} n={n} />}
        {borrowed >= 0.5 && (
          <p className="banner">
            Cash would run out, so the model borrows <b>Rs {money(borrowed)} cr</b> over {n} years to cover it.
            Lower capex or payout, or set <b>Planned borrowing change per year</b> yourself.
          </p>
        )}
        <section className="chart-card">
          <div className="tabs" role="tablist" aria-label="Chart">
            {METRICS.map(([k, label]) => (
              <button key={k} id={`chart-tab-${k}`} type="button" role="tab" className="tab" aria-selected={metric === k}
                aria-controls="chart-panel" tabIndex={metric === k ? 0 : -1} onClick={() => setMetric(k)}
                onKeyDown={e => groupKeys(e, METRICS.map(x => x[0]), metric, setMetric)}>{label}</button>
            ))}
          </div>
          <div id="chart-panel" role="tabpanel" aria-labelledby={`chart-tab-${metric}`}>
            <Chart title={m[1]} years={years} values={rows.map(m[2])} nHist={nHist} />
          </div>
        </section>
      </main>
      <div className="tables">
        <Statements layout={layout} years={years} rows={rows} nHist={nHist} />
      </div>
    </div>
  )
}

function Readout({ hist, proj, histYear, projYear, n }: { hist: Row[]; proj: Row[]; histYear: string; projYear: string; n: number }) {
  const last = hist[hist.length - 1], end = proj[proj.length - 1]
  const r0 = last.revenue ?? 0, r1 = end.revenue ?? 0
  const cagr = r0 > 0 && r1 > 0 ? (r1 / r0) ** (1 / n) - 1 : null
  const margin = (r: Row) => (r.revenue ? (r.pat ?? 0) / r.revenue : null)
  const fcf = proj.reduce((s, r) => s + (r.fcf ?? 0), 0)
  const netCash = (end.cash ?? 0) + (end.investments ?? 0) - (end.borrowings ?? 0)
  const P = ({ children }: { children: React.ReactNode }) => <span className="pencil-num">{children}</span>

  return (
    <p className="readout">
      Revenue goes from Rs {money(r0)} cr in {histYear} to <P>Rs {money(r1)} cr</P> in {projYear}
      {cagr != null && <>, <P>{fmt(cagr, 'pct')}</P> a year</>}. Net margin moves from {fmt(margin(last), 'pct')} to{' '}
      <P>{fmt(margin(end), 'pct')}</P>. Over {n} years the business {fcf >= 0 ? 'generates' : 'burns'}{' '}
      <P>Rs {money(Math.abs(fcf))} cr</P> of free cash and ends with{' '}
      <P>Rs {money(Math.abs(netCash))} cr</P> net {netCash >= 0 ? 'cash' : 'debt'}.
    </p>
  )
}
