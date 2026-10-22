import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Confirm, Menu, Scale, ScaleHead, ScaleKey, Verdict, latestOf, slugOf } from './Shell'
import { pathOf, placed } from './route'
import { api, clock, fmt, postJson, properName, rs, gap, verdict, type AutoState, type ModelSummary, type VerdictKind, type WatchList } from './lib'
import { ago, streamFetch } from './Fetch'
import { fy, qfy } from './lib'
import { Q_WORD, quarterWords } from './Tracking'
import { T } from './Term'
import { Prices, Spark, WatchSection } from './Watch'
import AddPage, { type BuildApi, type OnAdd } from './Add'

interface Props {
  models: ModelSummary[] | null
  error: string | null
  build: BuildApi
  onAdd: OnAdd
  onWatch: (s: string) => void
  watch: WatchList | null
  setWatch: (w: WatchList) => void
  watchMsg: ReactNode
  onDeleted: (ids: string[]) => void
  onChecked: (saved: { id: string; saved_at: string }[]) => void // "Check all for new results" saved these versions
  onReload: () => void // prices were refreshed, or the list failed: list again
}

const SORTS = { cheap: 'Upside (FV ÷ CMP)', flags: 'Most red flags', changed: 'Recently changed', name: 'A–Z' } as const
type Sort = keyof typeof SORTS
type Chip = 'all' | VerdictKind | 'results' | 'draft'
const PREFS = 'financial-model:coverage' // the sort and chip you last chose, this browser only
function pref<T extends string>(key: 'sort' | 'filter', ok: readonly T[], dflt: T): T {
  try { const v = JSON.parse(localStorage.getItem(PREFS) ?? '{}')[key]; return ok.includes(v) ? v : dflt } catch { return dflt }
}
const CHIPS: [Chip, (n: number) => string][] = [
  ['cheap', n => `${n} below bear FV`], ['range', n => `${n} within FV range`],
  ['dear', n => `${n} above bull FV`], ['fix', n => `${n} need${n === 1 ? 's' : ''} a fix`],
  ['results', n => `${n} new result${n === 1 ? '' : 's'}`], ['draft', n => `${n} not reviewed`],
]
const kindOf = (m: ModelSummary) => verdict(m.price, m.values).kind
const matches = (c: Chip, m: ModelSummary) => c === 'all' ? true : c === 'results' ? !!m.new_results?.length : c === 'draft' ? !m.reviewed_at : kindOf(m) === c

/** Coverage: each company with CMP against fair value on one shared scale, the filter chips, prices, Check all,
 * sort; the watchlist below. With no company yet it is the first-run screen. */
export default function Home({ models, error, build, onAdd, onWatch, watch, setWatch, watchMsg, onDeleted, onChecked, onReload }: Props) {
  const [sort, setSort] = useState<Sort>(() => pref('sort', Object.keys(SORTS) as Sort[], 'cheap'))
  const [chip, setChip] = useState<Chip>(() => pref('filter', ['all', 'cheap', 'range', 'dear', 'fix', 'none', 'results', 'draft'], 'all'))
  useEffect(() => { try { localStorage.setItem(PREFS, JSON.stringify({ sort, filter: chip })) } catch { /* private window */ } }, [sort, chip])
  const [gone, setGone] = useState<ModelSummary | null>(null)
  const [delError, setDelError] = useState<string | null>(null)
  const head = useRef<HTMLHeadingElement>(null)
  useEffect(() => { // back on the list from a company: focus its heading, like any page change (not on a cold load)
    if (models == null) return
    if (placed.once) document.getElementById('page-h')?.focus({ preventScroll: true })
    placed.once = true
  }, [models == null]) // eslint-disable-line react-hooks/exhaustive-deps

  if (models == null && !error) return (
    <main id="main" className="page" tabIndex={-1}>
      <h1 id="page-h" tabIndex={-1} className="h1">Coverage</h1>
      <ul className="cov skel" aria-label="Loading coverage" aria-busy="true">{[0, 1, 2].map(i => <li key={i} className="cov-row"><i /><i /><i /></li>)}</ul>
    </main>
  )
  if (error && !models?.length) return (
    <main id="main" className="page" tabIndex={-1}>
      <h1 id="page-h" tabIndex={-1} className="h1">Coverage</h1>
      <p className="notice-bar bad" role="alert">Couldn’t load coverage: {error.replace(/\.?$/, '.')} Your saved files are untouched.{' '}
        <button type="button" className="link" onClick={onReload}>Try again</button></p>
    </main>
  )
  if (!models!.length) return (
    <main id="main" className="page" tabIndex={-1}>
      <p className="label">Get started</p>
      <h1 id="page-h" tabIndex={-1} className="h1">Add your first company</h1>
      <p className="purpose">Enter a listed company’s name or NSE symbol. The app reads its NSE filings and, in about a minute, builds a
        three-statement model with <T k="dcf" /> fair value vs <T k="cmp" />, forensic checks and an editable forecast. Analysis, not a recommendation.</p>
      <AddPage first models={models} build={build} onAdd={onAdd} onWatch={onWatch} watchMsg={watchMsg} />
    </main>
  )

  const latest = latestOf(models)
  const count = (c: Chip) => latest.filter(m => matches(c, m)).length
  const shown = latest.filter(m => matches(chip, m))
  const ratio = (m: ModelSummary) => (m.price && m.values?.base != null ? m.values.base / m.price : null)
  const by = (f: (m: ModelSummary) => number | null) => (x: ModelSummary, y: ModelSummary) => (f(y) ?? -Infinity) - (f(x) ?? -Infinity)
  shown.sort(sort === 'cheap' ? by(ratio) : sort === 'flags' ? by(m => m.flags ?? null)
    : sort === 'changed' ? by(m => (m.saved_at ? new Date(m.saved_at).getTime() : null)) : (x, y) => x.company.localeCompare(y.company))
  const versionsOf = (m: ModelSummary) => models!.filter(x => slugOf(x.id) === slugOf(m.id))
  const remove = async (m: ModelSummary) => {
    setDelError(null)
    const ids = versionsOf(m).map(x => x.id)
    try {
      for (const id of ids) await api(`/api/models/${id}`, { method: 'DELETE' })
      onDeleted(ids)
      head.current?.focus()
    } catch (e) { setDelError(`Couldn’t delete ${m.company}: ${(e as Error).message}`) }
  }
  const n = gone ? versionsOf(gone).length : 0

  return (
    <main id="main" className="page" tabIndex={-1}>
      <div className="home-head">
        <div>
          <h1 id="page-h" tabIndex={-1} className="h1">Coverage</h1>
          <p className="purpose"><T k="cmp" /> against <T k="dcf" /> fair value (<T k="fv" />, bear–base–bull) for each company modelled, with reverse-DCF implied growth,
            red flags and latest results. Analysis, not a recommendation.</p>
        </div>
        <a className="primary big" href="/add">+ Add company</a>
      </div>

      <div className="chips" role="group" aria-label="Filter">
        <button type="button" className="chip-b" aria-pressed={chip === 'all'} onClick={() => setChip('all')}>All {latest.length}</button>
        {CHIPS.map(([c, words]) => {
          const k = count(c)
          return k > 0 || chip === c ? <button key={c} type="button" className={`chip-b c-${c}`} aria-pressed={chip === c} onClick={() => setChip(chip === c ? 'all' : c)}>{words(k)}</button> : null
        })}
      </div>

      <section className="cov-box" aria-labelledby="library-head">
        <h2 id="library-head" ref={head} tabIndex={-1} className="sr">Companies, {shown.length} shown</h2>
        <div className="cov-tools">
          <Prices models={latest} watch={watch?.watch ?? []} onDone={onReload} />
          {latest.some(m => m.symbol) && <CheckAll n={latest.filter(m => m.symbol).length} models={latest} onSaved={onChecked} />}
          {latest.some(m => m.symbol) && <AutoChecks />}
          <label className="sort">Sort <select className="sel" value={sort} onChange={e => setSort(e.target.value as Sort)}>
            {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        <ScaleKey />
        <div className="cov-head" aria-hidden="true"><span>Company</span><ScaleHead /><span>CMP vs FV</span><span>Flags · results</span></div>
        {shown.length === 0
          ? <p className="pad-s">No company matches. <button type="button" className="link" onClick={() => setChip('all')}>Show all {latest.length}</button></p>
          : <ul className="cov">{shown.map(m => <Row key={m.id} m={m} hist={watch?.history[slugOf(m.id)]} versions={versionsOf(m).length} onDelete={() => setGone(m)} />)}</ul>}
        {delError && <p className="error" role="alert">{delError}</p>}
      </section>

      <WatchSection list={watch} models={latest} onChange={setWatch} />
      {watchMsg && <p className="small" role="status">{watchMsg}</p>}
      <footer className="foot">
        <p>Non-financial companies only; banks, NBFCs and insurers aren’t supported yet.
          Models autosave to the <code>models</code> folder next to the app. Numbers are rule-computed; recalculation never calls AI.</p>
      </footer>
      <Confirm open={!!gone} onClose={() => setGone(null)} onYes={() => gone && remove(gone)} yes="Delete"
        title={gone ? `Delete ${gone.company}?` : ''}
        body={<p>Its assumptions, research note, documents{n > 1 ? ` and ${n} versions` : ''} are deleted too. This can’t be undone.</p>} />
    </main>
  )
}

/** One company: name and state, the verdict, fair value against CMP on the shared scale, implied growth, red flags
 * and results. */
function Row({ m, hist, versions, onDelete }: { m: ModelSummary; hist?: Parameters<typeof Spark>[0]['pts']; versions: number; onDelete: () => void }) {
  const slug = slugOf(m.id)
  const v = m.values
  const g = gap(m.price, v?.base)
  const state = `${m.symbol ?? 'Excel export'} · ${m.reviewed_at ? 'reviewed' : 'draft'}`
  const signs = m.flags ?? 0
  return (
    <li className="cov-row">
      <div className="c-name">
        <a className="c-open" href={pathOf(slug, 'summary')}>{properName(m.company)}</a>
        <span className="c-meta">{state}{m.new_results?.length ? <b> · new results</b> : null}</span>
        {v?.base != null && <p className="c-say">{assumes(m)}</p>}
      </div>
      {v?.base == null
        ? <div className="c-fix"><p className="c-say">No fair value: {m.why === 'final-year free cash flow is negative'
            ? 'terminal-year FCFF is negative, so TV is undefined.'
            : `${(m.why ?? 'open it for details').replace(/\.$/, '')}.`}</p>
            {m.why === 'final-year free cash flow is negative' || m.why?.startsWith('equity value is negative')
              ? <a className="btn" href={pathOf(slug, 'forecast', '', null, 'capex_pct')}>Fix the forecast</a>
              : <a className="btn" href={pathOf(slug, 'valuation', '', null, 'how')}>Details</a>}</div>
        : <div className="c-scale"><Scale price={m.price} bear={v.bear} base={v.base} bull={v.bull} /><Spark pts={hist} /></div>}
      <div className="c-vd">
        <Verdict price={m.price} values={v} words={false} />
        {v?.base != null && <span className="c-num">Base FV <b className="num ours">Rs {rs(v.base)}</b> · CMP <b className="num mkt">{m.price != null ? `Rs ${rs(m.price)}` : 'none'}</b>{g ? ` · ${g}` : ''}</span>}
        <PriceNote m={m} />
      </div>
      <div className="c-look">
        <a href={pathOf(slug, 'risks')} className={signs ? 'warn' : undefined}>{m.flags == null ? 'Red flags' : signs ? `${signs} red flag${signs > 1 ? 's' : ''}` : 'No red flags'}</a>
        {m.results_to && <span>Results to {qfy(m.results_to)}{m.new_results?.length ? <b> · new results</b> : null}</span>}
        {m.quarter?.status && <a href={pathOf(slug, 'tracking', '', null, 'quarter')} className={m.quarter.status === 'behind' ? 'warn' : undefined}
          title={quarterWords({ ...m.quarter, rev: m.quarter.revenue, pat: m.quarter.pat })}>
          {m.quarter.period} {fy(m.quarter.year)}: {Q_WORD[m.quarter.status].toLowerCase()}</a>}
      </div>
      <Menu label={`More for ${m.company}`} items={[
        { label: 'Open', href: pathOf(slug, 'summary') },
        { label: `Versions${versions > 1 ? ` (${versions})` : ''}`, href: pathOf(slug, 'versions') },
        { label: `Delete ${m.company}…`, onClick: onDelete, danger: true },
      ]} />
    </li>
  )
}

/** "Implied revenue growth 13.5% vs 5.8% base case." */
function assumes(m: ModelSummary): ReactNode {
  const ours = m.growth != null ? <> vs <span className="num">{fmt(m.growth, 'pct')}</span> base case</> : null
  if (m.price == null) return 'No CMP yet.'
  if (m.implied == null) return <>Implied growth outside −30% to +80%{ours}.</>
  return <>Implied revenue growth <b className="num">{fmt(m.implied, 'pct')}</b>{ours}.</>
}

/** Where CMP came from when it isn't the one saved in the model. */
function PriceNote({ m }: { m: ModelSummary }) {
  if (!m.symbol) return null
  if (!m.price_live) return <span className="small muted">CMP as saved, {ago(m.price_at)}</span>
  const moved = m.price_saved && m.price != null ? m.price / m.price_saved - 1 : null
  return moved != null && Math.abs(moved) >= 0.005
    ? <span className="small muted">Live CMP, {moved > 0 ? '+' : '−'}{fmt(Math.abs(moved), 'pct')} since the model was saved</span>
    : null
}

/** Scheduled checks: prices and new results for every company added by ticker, on app start and once a day while
 * the app runs (server, rules only); the last run in one line, and the setting to turn them off. */
function AutoChecks() {
  const [a, setA] = useState<AutoState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { api<AutoState>('/api/auto').then(setA).catch(() => setA(null)) }, [])
  if (!a) return null
  const flip = () => api<AutoState>('/api/auto', postJson({ enabled: !a.enabled })).then(x => { setA(x); setErr(null) })
    .catch(e => setErr((e as Error).message))
  const l = a.last
  return (
    <p className="small muted auto-line">
      <span>Scheduled checks {a.enabled ? 'on' : 'off'}{a.running ? ': checking now…'
        : l ? <>: last {clock(l.done_at)}, {l.new.length ? <>new results for {l.new.map((r, i) => <span key={r.id}>{i ? ', ' : ''}<a href={pathOf(slugOf(r.id), 'tracking')}>{properName(r.company)}</a></span>)}</> : 'nothing new'}{l.failed ? `, ${l.failed} couldn’t be reached` : ''}{a.next_at ? `; next ${clock(a.next_at)}` : ''}</>
        : a.enabled ? ': first run shortly after the app starts' : ''}.</span>{' '}
      <button type="button" className="link" onClick={flip} aria-describedby="auto-why">{a.enabled ? 'Turn off' : 'Turn on'}</button>
      <span id="auto-why" className="sr"> Checks NSE once a day for prices and new results, adds them and keeps your assumptions.</span>
      {err && <span role="alert"> {err}</span>}
    </p>
  )
}

interface CheckResult {
  id: string; company: string; status: 'new' | 'none' | 'skipped' | 'failed'; text: string; saved_at?: string
  kept?: string | null // failed: when the results the list still shows were last read from NSE
}

/** "Check all for new results": every company added by ticker, one after another (NSE once a second). New results
 * are saved as today's version with the forecast they replace kept for comparison; inputs never change. Stop keeps
 * what was saved so far. */
function CheckAll({ n, models, onSaved }: { n: number; models: ModelSummary[]; onSaved: (saved: { id: string; saved_at: string }[]) => void }) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'stopped' | 'failed'>('idle')
  const [results, setResults] = useState<CheckResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [at, setAt] = useState<string | null>(null)
  const ctl = useRef<AbortController | null>(null)
  useEffect(() => () => ctl.current?.abort(), [])
  const run = () => {
    const c = new AbortController()
    ctl.current = c
    setState('running'); setResults([]); setError(null)
    const saved: { id: string; saved_at: string }[] = []
    streamFetch<{ step?: string; result?: CheckResult; error?: string; done?: true }>({}, c.signal, e => {
      if (e.result) { setResults(r => [...r, e.result!]); if (e.result.status === 'new') saved.push({ id: e.result.id, saved_at: e.result.saved_at! }) }
      if (e.error) { setError(e.error); setState('failed') }
      if (e.done) setState('done')
    }, '/api/track/check')
      .catch(e => { if ((e as Error).name !== 'AbortError') { setError((e as Error).message); setState('failed') } })
      .finally(() => { setAt(clock(new Date().toISOString())); if (saved.length) onSaved(saved) })
  }
  const running = state === 'running'
  const found = results.filter(r => r.status === 'new')
  const failed = results.filter(r => r.status === 'failed')
  const done = results.filter(r => r.status !== 'skipped').length
  const kept = failed.map(r => r.kept).filter((x): x is string => !!x).sort()[0]
  const lastSaved = models.map(m => m.saved_at).filter((x): x is string => !!x).sort().at(-1)
  return (
    <div className="check-all" aria-busy={running}>
      <button type="button" className="btn" onClick={run} disabled={running}>Check all for new results</button>
      <span className="small muted" role="status">{running ? <>Checking {Math.min(done + 1, n)} of {n}… <button type="button" className="link" onClick={() => { ctl.current?.abort(); setState('stopped') }}>Stop</button></>
        : state === 'done' ? <>Checked {at}: {found.length ? <>new results for {found.map((r, i) => <span key={r.id}>{i ? ', ' : ''}<a href={pathOf(slugOf(r.id), 'tracking')}>{r.company}</a></span>)}</> : 'nothing new'}{failed.length
          ? `; couldn’t reach NSE for ${failed.map(r => r.company).join(', ')}${kept ? `, the list shows results as of ${clock(kept)}` : ''}` : ''}.{failed.length ? <> <button type="button" className="link" onClick={run}>Try again</button></> : null}</>
        : state === 'stopped' ? `Stopped after ${done} of ${n}${found.length ? `; ${found.length} saved with new results` : ''}. The rest weren’t checked.`
        : state === 'failed' ? <>Couldn’t reach NSE at {at}: {error} The list shows results as of {lastSaved ? clock(lastSaved) : 'the last save'}. <button type="button" className="link" onClick={run}>Try again</button></>
        : `Polls NSE for the ${n === 1 ? 'company' : `${n} companies`} added by ticker and adds any new results; assumptions are kept.`}</span>
    </div>
  )
}
