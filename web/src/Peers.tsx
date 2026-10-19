import { useEffect, useId, useRef, useState } from 'react'
import { ago, streamFetch } from './Fetch'
import { Checks, useAi } from './Sources'
import {
  api, fmt, money, when, postJson, type ModelDoc, type Parsed, type PeerCandidate, type PeerProposal, type PeerRow, type PeersDoc,
  type PeerTable, type Projection,
} from './lib'

const SYMBOL = /^[A-Z0-9&-]{1,20}$/
const MAX = 12 // peers compared at most (server.PeerFetchRequest)
const EMPTY: PeersDoc = { symbol: null, candidates: [], proposal: null, chosen: [], approved_at: null, rows: [] }
interface Ev { step?: string; detail?: string; note?: string; error?: string; company?: { sector: string | null; basic_industry?: string | null }; candidates?: PeerCandidate[]; row?: PeerRow }
interface Run { kind: 'find' | 'read'; steps: { text: string; detail?: string }[]; ctl: AbortController; stopped?: boolean }

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
const cell = (v: number | null | undefined, kind: 'num' | 'pct' | 'x') => fmt(v, kind)

/** Valuation → Against peers: find candidates (rules), let the AI pick (a proposal, checked by rules) or tick them
 * yourself, approve the set, then read each peer's numbers (rules, row by row, Stop keeps what's in). */
export function PeersSection({ parsed, doc, setDoc, projection, short }: {
  parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; projection: Projection | null; short: string
}) {
  const ai = useAi()
  const p = doc.peers ?? EMPTY
  const own = p.symbol ?? parsed.company.source?.symbol ?? null
  const [typed, setTyped] = useState('')
  const [run, setRun] = useState<Run | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [ticked, setTicked] = useState<string[]>(p.chosen)
  const head = useRef<HTMLHeadingElement>(null)
  useEffect(() => () => run?.ctl.abort(), []) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (f: (x: PeersDoc) => PeersDoc) => setDoc(d => ({ ...d, peers: f(d.peers ?? EMPTY) }))
  const choosing = !p.approved_at || editing
  const t = projection?.peers ?? null

  const go = async (kind: Run['kind'], url: string, body: unknown, on: (e: Ev) => void) => {
    const r: Run = { kind, steps: [], ctl: new AbortController() }
    setRun(r); setError(null); setNotes([])
    const step = (f: (s: Run['steps']) => Run['steps']) => setRun(x => (x && x.ctl === r.ctl ? { ...x, steps: f(x.steps) } : x))
    try {
      await streamFetch<Ev>(body, r.ctl.signal, e => {
        if (e.step) step(s => [...s, { text: e.step! }])
        if (e.detail) step(s => s.map((x, i) => (i === s.length - 1 ? { ...x, detail: e.detail } : x)))
        if (e.note) setNotes(n => [...n, e.note!])
        if (e.error) setError(e.error)
        on(e)
      }, url)
      setRun(x => (x?.ctl === r.ctl ? null : x))
    } catch (e) {
      if ((e as Error).name === 'AbortError') setRun(x => (x?.ctl === r.ctl ? { ...x, stopped: true } : x))
      else { setError((e as Error).message); setRun(null) }
    }
  }
  const find = (sym: string) => {
    let basic: string | null | undefined = null
    return go('find', '/api/peers/candidates', { symbol: sym }, e => {
      if (e.company) basic = e.company.basic_industry
      if (e.candidates) {
        const cands = e.candidates
        set(x => ({ ...x, symbol: sym, candidates: [...cands, ...x.candidates.filter(c => c.hand && !cands.some(k => k.symbol === c.symbol))], proposal: null }))
        if (ai?.available === false && !cands.length) setNotes(n => [...n, 'No companies by rules: add peers yourself below.'])
        // AI off: rules tick the same-industry ones (at most 5) as a default you approve, instead of 15 empty boxes
        if (ai?.available === false && !editing) setTicked(t => (t.length ? t
          : cands.filter(c => basic && c.basic_industry === basic).slice(0, 5).map(c => c.symbol)))
      }
    })
  }
  const read = (syms: string[]) => go('read', '/api/peers/fetch', { symbols: syms }, e => {
    if (e.row) { const row = e.row; set(x => ({ ...x, rows: [...x.rows.filter(r => r.symbol !== row.symbol), row] })) }
  })
  const pick = async () => {
    if (!own) return
    setPicking(true); setError(null)
    try {
      const r = await api<{ candidates: PeerCandidate[]; proposal: PeerProposal }>('/api/peers/pick', postJson({ symbol: own, notes: doc.notes }))
      const pass = r.proposal.picks.filter(k => k.pass).slice(0, 8).map(k => k.symbol)
      set(x => ({ ...x, symbol: own, proposal: r.proposal, candidates: [...r.candidates, ...x.candidates.filter(c => c.hand && !r.candidates.some(k => k.symbol === c.symbol))] }))
      setTicked(pass)
    } catch (e) { setError((e as Error).message) } finally { setPicking(false) }
  }
  const approve = () => {
    const keep = ticked.slice(0, MAX)
    set(x => ({ ...x, symbol: own ?? x.symbol, chosen: keep, approved_at: new Date().toISOString(), rows: x.rows.filter(r => r.symbol && keep.includes(r.symbol)) }))
    setEditing(false)
    const missing = keep.filter(s => !p.rows.some(r => r.symbol === s && r.metrics))
    if (missing.length) read(missing)
    head.current?.focus()
  }
  const toggle = (s: string) => setTicked(x => (x.includes(s) ? x.filter(y => y !== s) : [...x, s]))
  const addHand = (c: PeerCandidate) => {
    set(x => ({ ...x, candidates: x.candidates.some(k => k.symbol === c.symbol) ? x.candidates : [...x.candidates, c] }))
    setTicked(x => (x.includes(c.symbol) ? x : [...x, c.symbol]))
  }

  const steps = run && <div className="fetch peers-run" aria-busy={!run.stopped}>
    <ol className="steps" aria-live="polite">
      {run.steps.map((s, i) => {
        const now = i === run.steps.length - 1 && !run.stopped
        return <li key={i} className={now ? 'now' : 'done'}><span className="tick" aria-hidden="true">{now ? '' : '✓'}</span>
          <span>{s.text}{s.detail && now && <span className="muted"> {s.detail}</span>}</span><span className="sr">{now ? ' (in progress)' : ' (done)'}</span></li>
      })}
    </ol>
    <div className="fetch-act">
      {run.stopped
        ? <><span className="small">Stopped. {run.kind === 'read' ? 'The peers read so far are in the table.' : 'Nothing was lost; what was downloaded is kept.'}</span>
          <button type="button" className="link" onClick={() => setRun(null)}>Close</button></>
        : <><button type="button" className="btn" onClick={() => run.ctl.abort()}>Stop</button>
          <span className="small muted">{run.kind === 'find' ? 'Up to half a minute the first time: the app asks NSE once a second and keeps the answers, so the next time is quick.'
            : 'About 10 seconds a peer: NSE’s filings (kept for good), and older years from an Excel export of that peer when you have one.'}</span></>}
    </div>
  </div>
  const msgs = <>
    {notes.length > 0 && <ul className="fetch-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    {error && <p className="error" role="alert">{error}</p>}
  </>

  return (
    <section className="blk" id="peers" aria-labelledby="peers-h">
      <div className="strip-head">
        <h2 id="peers-h" tabIndex={-1} ref={head}>{choosing ? (p.approved_at ? 'Change peers' : 'Pick peers') : 'The peer table'}</h2>
        {!choosing && !run && <span className="peer-acts">
          <button type="button" className="link small" onClick={() => read(p.chosen)}>Update prices and results</button>
          <button type="button" className="link small" onClick={() => { setTicked(p.chosen); setEditing(true) }}>Change peers</button>
        </span>}
      </div>
      {choosing
        ? <Pick {...{ p, own, ai, typed, setTyped, find, pick, picking, ticked, toggle, approve, addHand, editing, run: !!run && !run.stopped }}
            cancel={() => { setEditing(false); setTicked(p.chosen) }} />
        : <>
          <p className="why">{short} against {p.chosen.length} listed {p.chosen.length === 1 ? 'company' : 'companies'} in its line of business, each on its last
            reported year. Rank 1 = best: largest, fastest growing, highest margins, returns and cash conversion, least debt, cheapest.</p>
          <Why p={p} />
          {steps}{msgs}
          {t ? <Table t={t} p={p} short={short} reading={run?.kind === 'read' && !run.stopped} retry={s => read([s])} />
            : (!run || run.stopped) && <p className="val-empty">No peer numbers yet. <button type="button" className="link" onClick={() => read(p.chosen)}>Read them from NSE</button></p>}
        </>}
      {choosing && <>{steps}{msgs}</>}
    </section>
  )
}

/** Choosing the peers: the rule candidates (and the AI's picks with their checks) as a ticked list, plus add-by-name. */
function Pick({ p, own, ai, typed, setTyped, find, pick, picking, ticked, toggle, approve, addHand, editing, run, cancel }: {
  p: PeersDoc; own: string | null; ai: ReturnType<typeof useAi>; typed: string; setTyped: (s: string) => void
  find: (s: string) => void; pick: () => void; picking: boolean; ticked: string[]; toggle: (s: string) => void; approve: () => void
  addHand: (c: PeerCandidate) => void; editing: boolean; run: boolean; cancel: () => void
}) {
  const id = useId()
  const by = new Map(p.proposal?.picks.map(k => [k.symbol, k]) ?? [])
  const rejected = p.proposal?.picks.filter(k => !k.pass) ?? []
  const sym = typed.trim().toUpperCase()
  const aiOff = ai?.available === false
  const cands = p.candidates
  return <>
    {/* the page answer above already says how peers are picked: here only what is compared, once candidates exist */}
    {cands.length > 0 && <p className="why">Compared on size, growth, margins, returns, debt and P/E, EV/EBITDA, P/B at today’s prices. Candidates
      come from the same NSE sector, closest in size.</p>}
    {!cands.length && (own
      ? <div className="empty-state"><p className="small muted">Start by listing same-sector companies on NSE.</p>
          <p className="next-act"><button type="button" className="primary" disabled={run} onClick={() => find(own)}>Find peers on NSE</button>
            {aiOff && <button type="button" className="btn" disabled>Let AI pick (AI off)</button>}</p></div>
      : <form className="peer-sym" onSubmit={e => { e.preventDefault(); if (SYMBOL.test(sym)) find(sym) }}>
        <label htmlFor={`${id}-sym`}>This model came from a file, so it doesn’t know its NSE symbol. Type it to find peers:</label>
        <span className="add-row"><input id={`${id}-sym`} type="text" value={typed} onChange={e => setTyped(e.target.value)} placeholder="e.g. TCS" spellCheck={false} autoComplete="off"
          aria-invalid={sym !== '' && !SYMBOL.test(sym)} />
        <button type="submit" className="primary" disabled={run || !SYMBOL.test(sym)}>Find peers</button></span>
      </form>)}
    {cands.length > 0 && <>
      {aiOff && cands.some(c => !c.hand) && <p className="peer-off">AI picking is off on this computer, so {ticked.length
        ? 'the closest companies in the same industry are ticked for you. Untick any that don’t fit, tick others'
        : 'tick the peers that fit'}. The list is NSE’s {cands[0]?.sector ?? 'same-sector'} companies: the same industry first, then the closest in size.</p>}
      {aiOff && <p><button type="button" className="btn" disabled>Let AI pick (AI off)</button></p>}
      {!aiOff && !p.proposal && own && <p><button type="button" className="primary" disabled={picking || run} onClick={pick}>
        {picking ? 'AI is picking…' : <>Let AI pick the closest <span className="ai-tag">AI</span></>}</button>{' '}
        <span className="small muted">or tick them yourself below.</span></p>}
      {p.proposal && <div className="peer-prop">
        <p><span className="tag ai">AI</span> Picked {p.proposal.picks.length}, of which {p.proposal.picks.filter(k => k.pass).length} passed every rule and
          {' '}{p.proposal.picks.filter(k => k.pass).length === 1 ? 'is' : 'are'} ticked. Basis: {p.proposal.basis === 'segments'
            ? 'its annual report’s segments and NSE’s classification'
            : 'NSE’s industry classification only; the reasons are the AI’s reading of these businesses, not quotes from filings'}.
          {' '}<button type="button" className="link" disabled={picking || run} onClick={pick}>{picking ? 'Asking again…' : 'Ask again'}</button></p>
        <Checks checks={p.proposal.checks} />
        {rejected.length > 0 && <details className="fold"><summary>{rejected.length} pick{rejected.length > 1 ? 's' : ''} rejected by the rules</summary>
          <ul className="peer-rej">{rejected.map(k => <li key={k.symbol}><b>{k.name} ({k.symbol})</b>: {k.reason}<Checks checks={k.checks.filter(c => !c.pass)} /></li>)}</ul>
        </details>}
      </div>}
      <fieldset className="peer-list">
        <legend>Peers to compare ({ticked.length} ticked{ticked.length > MAX ? `; at most ${MAX}` : ''})</legend>
        <ul>{cands.map(c => {
          const k = by.get(c.symbol)
          return <li key={c.symbol} className={ticked.includes(c.symbol) ? 'on' : undefined}>
            <label><input type="checkbox" checked={ticked.includes(c.symbol)} onChange={() => toggle(c.symbol)} />
              <span><b>{c.name}</b> <span className="tag">{c.symbol}</span>
                <span className="small muted"> {c.why}{c.mcap ? ` · market cap Rs ${money(c.mcap)} cr` : ''}</span>
                {k?.pass && <span className="peer-why"><span className="tag ai">AI</span> {k.reason}</span>}</span></label>
          </li>
        })}</ul>
      </fieldset>
    </>}
    <AddPeer onAdd={addHand} example={cands.find(c => !c.hand)} />
    {(cands.length > 0 || ticked.length > 0) && <div className="fetch-act">
      <button type="button" className="primary" disabled={!ticked.length || ticked.length > MAX || run} onClick={approve}>
        {!ticked.length ? 'Compare (tick at least one)' : `Compare with ${ticked.length === 1 ? 'this company' : `these ${ticked.length}`}`}</button>
      {editing && <button type="button" className="link" onClick={cancel}>Cancel</button>}
      {own && cands.length > 0 && <button type="button" className="link small" disabled={run} onClick={() => find(own)}>Find candidates again</button>}
    </div>}
  </>
}

/** "Add a peer by name": NSE's search as the browser's own suggestion list. */
function AddPeer({ onAdd, example }: { onAdd: (c: PeerCandidate) => void; example?: PeerCandidate }) {
  const id = useId()
  const [q, setQ] = useState('')
  const [found, setFound] = useState<{ q: string; hits: { symbol: string; name: string }[] }>({ q: '', hits: [] })
  const [msg, setMsg] = useState<string | null>(null)
  const text = q.trim()
  const hits = found.hits
  useEffect(() => {
    if (text.length < 2 || hits.some(h => h.symbol === text.toUpperCase())) return // a suggestion was picked
    const ctl = new AbortController()
    const t = window.setTimeout(() => api<{ results: { symbol: string; name: string }[]; error: string | null }>('/api/nse/search', postJson({ q: text }, ctl.signal))
      .then(r => { setFound({ q: text, hits: r.results }); if (r.error) setMsg(r.error) }).catch(() => undefined), 300)
    return () => { window.clearTimeout(t); ctl.abort() }
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps
  const add = () => {
    const low = text.toLowerCase() // a suggestion by symbol or name, else the first one found for exactly this text
    const hit = hits.find(h => h.symbol === text.toUpperCase() || h.name.toLowerCase() === low) ?? (found.q === text ? hits[0] : undefined)
    const sym = hit?.symbol ?? text.toUpperCase()
    if (!SYMBOL.test(sym)) { setMsg('Pick a company from the suggestions, or type its NSE symbol (like INFY).'); return }
    onAdd({ symbol: sym, name: hit?.name ?? sym, why: 'Added by you', hand: true })
    setQ(''); setMsg(null)
  }
  return <form className="peer-add" id="peer-add" onSubmit={e => { e.preventDefault(); add() }}>
    <label htmlFor={`${id}-q`}>Add a peer by name or NSE symbol</label>
    <span className="add-row">
      <input id={`${id}-q`} type="text" list={`${id}-l`} value={q} onChange={e => { setQ(e.target.value); setMsg(null) }} placeholder={example ? `e.g. ${example.name.replace(/\s+(Limited|Ltd\.?)$/i, '')} or ${example.symbol}` : 'e.g. Infosys or INFY'} autoComplete="off" spellCheck={false} />
      <datalist id={`${id}-l`}>{hits.map(h => <option key={h.symbol} value={h.symbol}>{h.name}</option>)}</datalist>
      <button type="submit" className="btn" disabled={text.length < 1}>Add</button>
    </span>
    {msg && <span className="small bad" role="status">{msg}</span>}
  </form>
}

/** The comparison: the company (highlighted), each peer, the peers' median and the company's rank per measure. */
function Table({ t, p, short, reading, retry }: { t: PeerTable; p: PeersDoc; short: string; reading: boolean; retry: (s: string) => void }) {
  const cols = t.columns.map(([k, label, kind, way]) => [k, PLAIN[k]?.[0] ?? label, kind, way, PLAIN[k]?.[1]] as const)
  const waiting = p.chosen.filter(s => !t.peers.some(r => r.symbol === s))
  const at = t.peers.map(r => r.at).filter(Boolean).sort()[0]
  return <>
    <div className="table-wrap peer-wrap" tabIndex={0} role="region" aria-labelledby="peer-cap">
      <table className="peer-table">
        <caption id="peer-cap" className="visually-hidden">The company against its peers: measures, the peers’ median and the company’s rank</caption>
        <thead><tr><th scope="col">Company</th><th scope="col">Year</th>{cols.map(([k, label, , , dir]) => <th key={k} scope="col">{label}{dir && <span className="col-dir">{dir}</span>}</th>)}</tr></thead>
        <tbody>
          <tr className="is-own"><th scope="row">{t.own.name} <span className="sr">(this company)</span></th><td>{t.own.year}</td>
            {cols.map(([k, , kind]) => <td key={k}>{cell(t.own.metrics?.[k], kind)}</td>)}</tr>
          {t.peers.filter(r => p.chosen.includes(r.symbol ?? '')).map(r => r.metrics
            ? <tr key={r.symbol}><th scope="row" title={r.source ?? undefined}>{r.name} <span className="tag">{r.symbol}</span></th><td>{r.year}</td>
              {cols.map(([k, , kind]) => <td key={k}>{cell(r.metrics?.[k], kind)}</td>)}</tr>
            : <tr key={r.symbol} className="is-miss"><th scope="row">{r.name && r.name !== r.symbol ? <>{r.name} <span className="tag">{r.symbol}</span></> : r.symbol}</th>
              <td colSpan={cols.length + 1} className="peer-err">Couldn’t read: {r.error} <button type="button" className="link" disabled={reading} onClick={() => retry(r.symbol!)}>Try again</button></td></tr>)}
          {waiting.map(s => <tr key={s} className="is-miss"><th scope="row">{s}</th>
            <td colSpan={cols.length + 1} className="peer-err">{reading ? 'Reading…' : <>Not read yet. <button type="button" className="link" onClick={() => retry(s)}>Read it</button></>}</td></tr>)}
          <tr className="total"><th scope="row">Peer median</th><td />{cols.map(([k, , kind]) => <td key={k}>{cell(t.median[k], kind)}</td>)}</tr>
          <tr className="peer-rank"><th scope="row">{short}’s rank</th><td />
            {cols.map(([k]) => <td key={k}>{t.rank[k] == null ? '–' : `${ordinal(t.rank[k]!)} of ${t.of[k]}`}</td>)}</tr>
        </tbody>
      </table>
    </div>
    <p className="small-note">Numbers from each company’s NSE results filings, read by rules; older years come from an Excel export of
      that company when you have one (hover a name to see where each year came from). Market cap and multiples at NSE prices read {ago(at)}; {short} at the price in this model.
      Growth is revenue CAGR; ROCE = EBIT / average capital employed; cash conversion = cash from operations / net profit over 3 years; EV = market cap +
      borrowings − cash − investments. Blank: not enough years, or a negative base. Leases count as debt only where the source includes them.</p>
  </>
}

const PLAIN: Record<string, [string, string]> = {
  mcap: ['Size: market cap, Rs cr', 'higher is bigger'], pe: ['Price ÷ earnings (P/E)', 'lower is cheaper'],
  ev_ebitda: ['Company value ÷ operating profit (EV/EBITDA)', 'lower is cheaper'], pb: ['Price ÷ book value (P/B)', 'lower is cheaper'],
  revenue: ['Sales, Rs cr', 'higher is bigger'], g3: ['Sales growth, 3 years', 'higher is faster'], g5: ['Sales growth, 5 years', 'higher is faster'],
  ebitda_margin: ['Operating margin (EBITDA)', 'higher is better'], net_margin: ['Net margin', 'higher is better'],
  roce: ['Return on capital (ROCE)', 'higher is better'], cash_conv: ['Cash conversion, 3 years', 'cash from operations ÷ profit; higher is better'],
  nd_ebitda: ['Net debt ÷ operating profit', 'lower is safer'],
}

/** Why these peers: when and how the set was approved, then the reason per pick (the AI's, with its basis, or yours). */
function Why({ p }: { p: PeersDoc }) {
  const by = new Map(p.proposal?.picks.map(k => [k.symbol, k]) ?? [])
  const name = (s: string) => p.candidates.find(c => c.symbol === s)?.name ?? p.rows.find(r => r.symbol === s)?.name ?? s
  const aiN = p.chosen.filter(s => by.get(s)?.pass).length
  return <details className="fold">
    <summary><span><b>Why these peers</b> · approved {p.approved_at ? when(p.approved_at).replace(/ \d{4}$/, '') : ''}: {aiN ? `${aiN} picked by AI and checked by rules, ` : ''}{p.chosen.length - aiN} ticked by you{p.candidates[0]?.sector ? `; NSE’s ${p.candidates[0].sector} companies` : ''}</span></summary>
    <ul className="peer-rej">{p.chosen.map(s => {
      const k = by.get(s)
      return <li key={s}><b>{name(s)}</b> ({s}): {k?.pass ? <><span className="tag ai">AI</span> {k.reason}</>
        : p.candidates.find(c => c.symbol === s)?.hand ? 'Added by you.' : `Ticked by you. ${p.candidates.find(c => c.symbol === s)?.why ?? ''}`}</li>
    })}</ul>
    {p.proposal && <p className="small-note">The AI chose from the companies rules found on NSE; every pick was checked (on the list, not this
      company, NSE data there, basis stated, one plain line) and you approved the set. Basis: {p.proposal.basis === 'segments' ? 'the annual report’s segments and NSE’s classification' : 'NSE’s industry classification only'}.</p>}
  </details>
}

/** "Against 4 peers, TCS ranks 2nd of 5 on ROCE (...), ... and 3rd cheapest of 5 on P/E (...)." */
export function peerWords(t: PeerTable, read: number, short: string) {
  const bit = (k: string, what: string, kind: 'pct' | 'x', cheap = false) => t.rank[k] == null || t.median[k] == null ? null
    : `${cheap && t.rank[k] === 1 ? 'the cheapest' : `${ordinal(t.rank[k]!)}${cheap ? ' cheapest' : ''}`} of ${t.of[k]} on ${what} (${fmt(t.own.metrics?.[k], kind)} against a median ${fmt(t.median[k], kind)})`
  const parts = [bit('roce', 'ROCE', 'pct'), bit('g3', '3-year growth', 'pct'), bit('pe', 'P/E', 'x', true)].filter(Boolean) as string[]
  return `Against ${read} peer${read > 1 ? 's' : ''}, ${short} ranks ${parts.length
    ? parts.join(parts.length > 2 ? ', ' : ' and ').replace(/, (?=[^,]*$)/, ' and ') : 'on too few measures to say'}.`
}

