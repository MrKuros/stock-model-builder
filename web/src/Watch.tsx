import { useEffect, useRef, useState } from 'react'
import { api, clock, rs, type ModelSummary, type Watched, type WatchList } from './lib'
import { ago, streamFetch } from './Fetch'
import { Menu } from './Shell'

const FRESH = 15 * 60_000 // a price this recent isn't asked for again (the server's cache says the same)

/** The coverage page's price line: when NSE's prices were checked, Refresh, progress with Stop, and what happens when
 * NSE can't be reached (the last prices kept stay on screen). Opening the page refreshes prices older than 15 minutes
 * by itself; nothing here changes a saved model or calls the AI. */
export function Prices({ models, watch, onDone }: { models: ModelSummary[]; watch: Pick<Watched, 'at'>[]; onDone: () => void }) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'stopped' | 'offline'>('idle')
  const [step, setStep] = useState<string | null>(null)
  const [missed, setMissed] = useState<string[]>([])
  const [checked, setChecked] = useState(0)
  const ctl = useRef<AbortController | null>(null)
  const times = [...models.filter(m => m.symbol).map(m => m.price_live ? m.price_at : null), ...watch.map(w => w.at)]
  const oldest = times.filter((t): t is string => !!t).sort()[0] ?? null
  const stale = times.some(t => t == null || Date.now() - new Date(t).getTime() > FRESH)
  const run = () => {
    const c = new AbortController()
    ctl.current?.abort()
    ctl.current = c
    setState('running'); setStep(null); setMissed([])
    const miss: string[] = []
    let stopped = false, n = 0
    streamFetch<{ step?: string; failed?: { symbol: string; text: string }; error?: string; done?: true; stopped?: boolean; checked?: number }>({}, c.signal, e => {
      if (e.step) setStep(e.step)
      if (e.failed) { miss.push(e.failed.symbol); setMissed([...miss]) }
      if (e.error) { stopped = true; setStep(e.error) }
      if (e.done) { stopped = !!e.stopped || miss.length > 0; n = e.checked ?? 0 }
    }, '/api/watch/prices')
      .then(() => { setChecked(n); setState(stopped ? 'offline' : 'done'); onDone() })
      .catch(e => { if ((e as Error).name !== 'AbortError') { setStep((e as Error).message); setState('offline') } })
  }
  useEffect(() => { if (times.length && stale) run() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => ctl.current?.abort(), [])
  if (!times.length) return null
  const running = state === 'running'
  return (
    <div className="prices" aria-busy={running}>
      <span className="small">{oldest
        ? <>NSE prices as of <b className="num">{clock(oldest)}</b> ({ago(oldest)})</>
        : 'Prices not checked yet'}</span>
      {running
        ? <><span className="small muted" role="status">{step ?? 'Fetching prices…'}</span>
          <button type="button" className="link" onClick={() => { ctl.current?.abort(); setState('stopped') }}>Stop</button></>
        : <button type="button" className="link" onClick={run}>Refresh prices</button>}
      {state === 'done' && <span className="small muted" role="status">{checked
        ? `Updated ${checked} price${checked > 1 ? 's' : ''}.`
        : `Prices under 15 minutes old; NSE not polled again${oldest ? `. Try after ${clock(new Date(new Date(oldest).getTime() + FRESH).toISOString())}` : ''}.`}</span>}
      {state === 'stopped' && <span className="small muted" role="status">Stopped. Prices fetched so far are shown; the rest are the last cached.</span>}
      {state === 'offline' && <span className="small warn" role="status">Couldn’t reach NSE{missed.length ? ` for ${missed.join(', ')}` : ''}.
        Showing last cached prices{oldest ? `, from ${clock(oldest)}` : ''}. Try again in a minute.</span>}
    </div>
  )
}

/** CMP (ochre) against base fair value (blue) for each day the coverage page refreshed prices. */
export function Spark({ pts }: { pts: [string, number, number | null, number, number | null][] | undefined }) {
  if (!pts || pts.length < 2) return null
  const w = 120, h = 26, vs = pts.flatMap(p => [p[1], p[3]])
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1
  const line = (i: 1 | 3) => pts.map((p, j) => `${(j / (pts.length - 1)) * w},${h - 2 - ((p[i] - lo) / span) * (h - 4)}`).join(' ')
  const a = pts[0], b = pts[pts.length - 1]
  const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  return (
    <span className="spark-w">
      <svg className="cov-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img"
        aria-label={`Since ${day(a[0])}: CMP Rs ${rs(a[1])} to Rs ${rs(b[1])}, base FV Rs ${rs(a[3])} to Rs ${rs(b[3])}`}>
        <polyline points={line(3)} className="sp-ours" />
        <polyline points={line(1)} className="sp-mkt" />
      </svg>
      <span className="small muted">since {day(a[0])}</span>
    </span>
  )
}

/** Tickers on the watchlist without a model yet: CMP, Build model (Add company, by that symbol) and Stop watching. */
export function WatchSection({ list, models, onChange }: { list: WatchList | null; models: ModelSummary[]; onChange: (w: WatchList) => void }) {
  const [error, setError] = useState<string | null>(null)
  const head = useRef<HTMLHeadingElement>(null)
  const modelled = new Set(models.map(m => m.symbol).filter(Boolean))
  const rows = (list?.watch ?? []).filter(w => !modelled.has(w.symbol))
  const remove = async (w: Watched) => {
    try { onChange(await api<WatchList>(`/api/watch/${encodeURIComponent(w.symbol)}`, { method: 'DELETE' })); head.current?.focus() } catch (e) { setError((e as Error).message) }
  }
  if (!rows.length) return null
  return (
    <section aria-labelledby="watch-head" className="watching" id="watching" tabIndex={-1}>
      <h2 id="watch-head" ref={head} tabIndex={-1}>Watchlist <span className="cnt">price only, not modelled</span></h2>
      <p className="purpose">Build a model for fair value and forensic checks.</p>
      <ul className="watch-list">{rows.map(w => (
        <li key={w.symbol}>
          <span className="c-name"><b>{w.name}</b><span className="c-meta">{w.symbol}{w.industry ? ` · ${w.industry}` : ''}</span></span>
          <span className="w-px">{w.price != null ? <>CMP <b className="num mkt">Rs {rs(w.price)}</b> · {ago(w.at)}</> : 'No CMP yet'}</span>
          <a className="primary" href={`/add?symbol=${encodeURIComponent(w.symbol)}`}>Build model</a>
          <Menu label={`More for ${w.name}`} items={[{ label: 'Stop watching', onClick: () => remove(w) }]} />
        </li>))}</ul>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
