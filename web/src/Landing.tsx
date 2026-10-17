import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MiniRange, latestOf, rangeWords, slugOf } from './Shell'
import { pathOf, placed } from './route'
import { NAMES, api, fmt, rs, when, type ModelSummary, type Parsed } from './lib'

interface Props {
  models: ModelSummary[] | null
  error: string | null
  onAdd: (p: Parsed) => Promise<void> // saves the new company and opens its Overview
  onDeleted: (id: string) => void
}

/** Your companies: every saved model with its price against our value range, and the add-a-company panel. With an
 * empty library it is the first-run screen: drop a Export export or try the sample, then straight to the Overview. */
export default function Landing({ models, error: listError, onAdd, onDeleted }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const libHead = useRef<HTMLHeadingElement>(null)
  useEffect(() => { // back on the list from a company: focus its heading, like any page change (not on a cold load)
    if (models == null) return
    if (placed.once) document.getElementById('page-h')?.focus({ preventScroll: true })
    placed.once = true
  }, [models == null]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, req: () => Promise<Parsed>) => {
    if (busy) return // one load at a time, so a slow earlier upload can't replace a later one
    setBusy(label)
    setError(null)
    try { await onAdd(await req()) } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const upload = (f: File | undefined) => {
    if (!f) return
    const body = new FormData()
    body.append('file', f)
    run(`Reading ${f.name}…`, () => api<Parsed>('/api/parse', { method: 'POST', body }))
  }
  const sample = () => run('Loading the sample…', () => api<Parsed>('/api/sample'))
  const remove = async (m: ModelSummary) => {
    const date = m.saved_at ? when(m.saved_at) : 'earlier'
    if (!window.confirm(`Delete the ${m.company} model saved ${date}? This can’t be undone.`)) return
    try {
      await api(`/api/models/${m.id}`, { method: 'DELETE' })
      onDeleted(m.id)
      ;((models?.length ?? 0) > 1 ? libHead : input).current?.focus() // the focused row is gone
    } catch (e) { setError((e as Error).message) }
  }

  const drop = (big: boolean) => (
    <label className={`drop${big ? ' big' : ''}${over ? ' is-over' : ''}`} aria-busy={!!busy}
      onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]) }}>
      <input ref={input} type="file" accept=".xlsx" className="sr" disabled={!!busy}
        onChange={e => { upload(e.target.files?.[0]); e.target.value = '' }} />
      {big && <svg className="up" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-5 5m5-5 5 5M4 20h16" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>}
      <strong>{busy ?? (big ? 'Drop a Export export here' : 'Add a company')}</strong>
      {!busy && <span>{big ? 'or ' : 'Drop a Export.in export here, or '}<u>choose a file</u> (.xlsx)</span>}
    </label>
  )
  const err = (error || listError) && <p className="error" role="alert">{error ?? listError}</p>

  if (models == null) return <main id="main" className="page" tabIndex={-1}><p className="muted pad" role="status">Opening your companies…</p></main>

  if (!models.length) return (
    <main id="main" className="page first" tabIndex={-1}>
      <p className="label">Get started · <b>one step</b></p>
      <h1 id="page-h" tabIndex={-1}>Add your first company</h1>
      <p className="purpose">Give the app a company’s financials from Export.in. In a few seconds you get a valuation, ten
        years of fundamentals and a forecast you can change.</p>
      <div className="choices">
        {drop(true)}
        <div className="sample"><b>No file yet?</b>
          <p>Open a made-up company to see how everything works. You can delete it later.</p>
          <button className="primary" type="button" onClick={sample} disabled={!!busy}>Try the sample company</button></div>
      </div>
      {err}
      <ol className="how" aria-label="How to get the file">
        <li><b>1. Open export.in</b>Search for the company. A free account is enough.</li>
        <li><b>2. Click “Export to Excel”</b>It’s on the company page, above the numbers.</li>
        <li><b>3. Drop the file above</b>Works for non-financial companies; banks, NBFCs and insurers aren’t supported.</li>
      </ol>
    </main>
  )

  // newest version of each company leads; older days follow, dimmed
  const latest = latestOf(models)
  const isLatest = new Set(latest.map(m => m.id))
  const below = latest.filter(m => m.price != null && m.values?.bear != null && m.price < m.values.bear)
  const above = latest.filter(m => m.price != null && m.values?.bull != null && m.price > m.values.bull)
  const count = (ms: ModelSummary[], one: string, many: string) => ms.length === 1 ? `${ms[0].company} ${one}` : `${ms.length} companies ${many}`
  const headline = below.length ? `${count(below, 'trades below even our cautious (bear) value', 'trade below even our cautious (bear) value')}.`
    : above.length ? `${count(above, 'trades above even our hopeful (bull) value', 'trade above even our hopeful (bull) value')}.`
    : `${latest.length === 1 ? 'One company' : `${latest.length} companies`} covered, all priced inside our range.`

  return (
    <main id="main" className="page" tabIndex={-1}>
      <div className="land-head">
        <div>
          <p className="label">Your companies · <b>computed by rules</b> · base case</p>
          <h1 id="page-h" tabIndex={-1}>{headline}</h1>
          <p className="purpose">Open a company to see what its price assumes against what the business does, ten years of
            fundamentals, the forecast and the checks behind it. Analysis, not a recommendation.</p>
        </div>
        <div className="add">
          {drop(false)}
          <p className="small muted">On export.in open the company and click <b>Export to Excel</b> (free account).{' '}
            <button type="button" className="link" disabled={!!busy} onClick={sample}>Try a sample company</button> (made-up numbers).</p>
          {err}
        </div>
      </div>

      <section aria-labelledby="library-head">
        <h2 id="library-head" ref={libHead} tabIndex={-1} className="label sec-label">
          <span>Companies · <b>price against our value range</b></span><span>newest first</span>
        </h2>
        <div className="legend" aria-hidden="true">
          <span><i className="lg-band" />Our value range, cautious (bear) to hopeful (bull)</span>
          <span><i className="lg-mkt" />Today’s price</span>
        </div>
        <ul className="cov">
          {models.map(m => { const latest = isLatest.has(m.id); return (
            <li key={m.id} className={`cov-row${latest ? '' : ' old'}`}>
              <a className="cov-open" href={pathOf(slugOf(m.id), m.values?.base == null ? 'forecast' : 'overview', '', latest ? null : m.id.split('/')[1])}>
                <span className="co"><strong>{m.company}</strong>
                  <span>{m.saved_at ? when(m.saved_at) : '–'} · {NAMES[m.active]} · {m.n} yrs
                    {m.reviewed_at ? ' · reviewed' : ' · draft'}{latest ? '' : ' · older version'}</span></span>
                <MiniRange price={m.price ?? null} bear={m.values?.bear ?? null} base={m.values?.base ?? null} bull={m.values?.bull ?? null} />
                <span className="pf">{coverText(m)}</span>
                <span className="fl">{m.flags == null ? '' : m.flags ? `${m.flags} warning sign${m.flags > 1 ? 's' : ''}` : 'No warning signs'}</span>
              </a>
              <button type="button" className="link lib-del" disabled={!!busy} onClick={() => remove(m)}
                aria-label={`Delete ${m.company}, saved ${m.saved_at ? when(m.saved_at) : 'earlier'}`}>Delete</button>
            </li>
          ) })}
        </ul>
      </section>
      <footer className="foot">
        <p>Works for manufacturing, services and other non-financial companies; banks, NBFCs and insurers aren’t
          supported. Models save themselves to the <code>models</code> folder next to the app. Analysis, not a
          recommendation: no management access or channel checks.</p>
      </footer>
    </main>
  )
}

function coverText(m: ModelSummary): ReactNode {
  if (m.values?.base == null) return <span className="muted">No value yet: {(m.why ?? 'open it to see why').replace(/\.$/, '')}. Open it to fix the forecast.</span>
  const where = rangeWords(m.price ?? null, m.values.bear ?? null, m.values.base, m.values.bull ?? null)
  if (m.implied != null && m.growth != null)
    return <>{where}<br /><span className="muted">Priced for <span className="num mkt">{fmt(m.implied, 'pct')}</span> growth a year / ours <span className="num ours">{fmt(m.growth, 'pct')}</span></span></>
  if (m.price == null) return <>Base <span className="num ours">Rs {rs(m.values.base)}</span>, no price</>
  return <>Base <span className="num ours">Rs {rs(m.values.base)}</span>, no growth rate reaches the price</>
}
