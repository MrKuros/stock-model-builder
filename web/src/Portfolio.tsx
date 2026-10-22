import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { DL, Menu, PageHead, Verdict, slugOf } from './Shell'
import { pathOf, placed } from './route'
import { api, dec2, fmt, money, pc, postJson, properName, qfy, rs, type Holding, type HoldingRow, type ModelSummary, type PortfolioView } from './lib'
import { Prices } from './Watch'
import { Q_WORD } from './Tracking'
import { T } from './Term'

const SORTS = { weight: 'Weight', upside: 'Upside to base FV', pnl: 'P&L %', name: 'A–Z' } as const
type Sort = keyof typeof SORTS
/** "1,250" or "Rs 1,250.50" as a number; NaN for anything else. */
const num = (s: string) => Number(s.replace(/^\s*(rs\.?|₹)/i, '').replace(/[,\s]/g, '') || 'x')
const name = (r: HoldingRow) => properName(r.name ?? r.symbol).replace(/\s+(ltd\.?|limited)$/i, '')
const signed = (v: number | null | undefined, kind: 'pct' | 'rs') => v == null ? '–'
  : `${v > 0 ? '+' : ''}${kind === 'pct' ? pc(v) : `Rs ${money(v)}`}`

/** Portfolio: your holdings (symbol, quantity, average cost; stored in models/portfolio.json) at CMP against each
 * company's base-case fair value, with look-through multiples, NSE sector exposure, concentration, red flags and new
 * results. Rules only, from the cached prices; nothing here calls the AI or changes a model. */
export default function Portfolio({ models }: { models: ModelSummary[] | null }) {
  const [p, setP] = useState<PortfolioView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<ReactNode>(null)
  const [sort, setSort] = useState<Sort>('weight')
  const [edit, setEdit] = useState<Holding | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const load = () => api<PortfolioView>('/api/portfolio').then(x => { setP(x); setError(null) }).catch(e => setError((e as Error).message))
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!p) return
    if (placed.once) document.getElementById('page-h')?.focus({ preventScroll: true })
    placed.once = true
  }, [p == null]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (holdings: Holding[], done: ReactNode) => {
    try { setP(await api<PortfolioView>('/api/portfolio', postJson({ holdings }))); setMsg(done); return true }
    catch (e) { setMsg(<span className="bad">Not saved: {(e as Error).message}</span>); return false }
  }
  const list = (): Holding[] => (p?.holdings ?? []).map(({ symbol, qty, cost }) => ({ symbol, qty, cost }))
  const remove = (r: HoldingRow) => {
    const before = list()
    save(before.filter(h => h.symbol !== r.symbol), <>Removed {r.symbol}. <button type="button" className="link" onClick={() => save(before, `Restored ${r.symbol}.`)}>Undo</button></>)
  }

  if (!p) return (
    <main id="main" className="page" tabIndex={-1}>
      <h1 id="page-h" tabIndex={-1} className="h1">Portfolio</h1>
      {error ? <p className="notice-bar inline bad" role="alert">Couldn’t load the portfolio: {error.replace(/\.?$/, '.')} <button type="button" className="link" onClick={load}>Try again</button></p>
        : <div className="skel-block" aria-busy="true" />}
    </main>
  )

  const rows = [...p.holdings]
  const key = (f: (r: HoldingRow) => number | null) => (a: HoldingRow, b: HoldingRow) => (f(b) ?? -Infinity) - (f(a) ?? -Infinity)
  rows.sort(sort === 'weight' ? key(r => r.weight) : sort === 'upside' ? key(r => r.upside)
    : sort === 'pnl' ? key(r => r.pnl != null && r.invested ? r.pnl / r.invested : null) : (a, b) => name(a).localeCompare(name(b)))
  const t = p.total, m = p.multiples, c = p.concentration
  const unmodelled = p.holdings.filter(r => !r.id)
  const fresh = p.holdings.filter(r => r.new_results?.length)
  const withFv = p.holdings.filter(r => r.fv != null && r.value != null).length
  const answer = !p.holdings.length ? 'No holdings yet. Enter each as symbol, quantity and average cost, or paste them as CSV.'
    : t.value == null ? `${p.holdings.length} holding${p.holdings.length > 1 ? 's' : ''}, none with a CMP yet: refresh prices.`
    : <>Market value <b className="num mkt">Rs {money(t.value)}</b> across {p.holdings.length} holding{p.holdings.length > 1 ? 's' : ''}{t.unpriced.length ? ` (${t.unpriced.length} without a CMP)` : ''}; unrealised P&L{' '}
      <b className="num">{signed(t.pnl, 'rs')}</b> ({signed(t.pnl != null && t.invested ? t.pnl / t.invested : null, 'pct')}).
      {t.upside != null && <> Base-case FV of the {withFv} modelled holding{withFv > 1 ? 's' : ''} ({pc(t.fv_cover)} of value) implies{' '}
        <b className="num ours">{pc(Math.abs(t.upside))} {t.upside >= 0 ? 'upside' : 'downside'}</b> to CMP.</>}
      {m.pe.value != null && <> Look-through P/E <b className="num">{fmt(m.pe.value, 'x')}</b>;</>} top-5 weight {pc(c.top5)}.</>
  const next = unmodelled.length
    ? <a className="primary" href={`/add?symbol=${encodeURIComponent(unmodelled[0].symbol)}`}>Build model: {unmodelled[0].symbol}</a>
    : fresh.length ? <a className="primary" href={pathOf(slugOf(fresh[0].id!), 'tracking')}>New results: {name(fresh[0])}</a>
    : p.holdings.length ? <a className="btn" href="/api/portfolio.xlsx" download>{DL}Excel</a> : null

  return (
    <main id="main" className="page portfolio" tabIndex={-1}>
      <PageHead label="Library" title="Portfolio"
        purpose={<>Your holdings at <T k="cmp" /> against each company’s base-case <T k="fv" />, with look-through multiples, sector exposure
          and concentration. Stored on this computer in <code>models/portfolio.json</code>. Analysis, not a recommendation.</>}
        answer={answer} next={next} />
      {p.damaged && <p className="notice-bar inline bad" role="alert"><code>portfolio.json</code> in the models folder is damaged, so no holdings
        are shown and nothing will be saved over it. Move the file away (or fix it) and reload.</p>}

      {p.holdings.length > 0 && <>
        <dl className="pf-kpis">
          <Kpi k={<T k="mv" />} v={t.value == null ? '–' : `Rs ${money(t.value)}`} sub={`Invested Rs ${money(t.invested)}`} />
          <Kpi k={<T k="upnl" />} v={signed(t.pnl, 'rs')} sub={signed(t.pnl != null && t.invested ? t.pnl / t.invested : null, 'pct')} />
          <Kpi k={<>To base <T k="fv" /></>} v={t.upside == null ? '–' : `${t.upside >= 0 ? '+' : ''}${pc(t.upside)}`} sub={t.upside == null ? 'No holding has a model' : `${pc(t.fv_cover)} of value modelled`} tone="ours" />
          <Kpi k={<><T k="lookthrough">Look-through</T> <T k="pe" /></>} v={fmt(m.pe.value, 'x')} sub={`${pc(m.pe.cover)} of value`} />
          <Kpi k={<><T k="ev_ebitda" /> ex-lenders</>} v={fmt(m.ev_ebitda.value, 'x')} sub={`${pc(m.ev_ebitda.cover)} of value`} />
          <Kpi k={<><T k="pb" /> lenders</>} v={fmt(m.pb.value, 'x')} sub={m.pb.cover ? `${pc(m.pb.cover)} of value` : 'No lender held'} />
        </dl>

        <section className="blk" aria-labelledby="hold-h">
          <div className="strip-head">
            <h2 id="hold-h">Holdings <span className="cnt">{p.holdings.length}</span></h2>
            <div className="pf-tools">
              <Prices models={[]} watch={p.holdings.map(r => ({ at: r.price_at }))} onDone={load} />
              <label className="sort">Sort <select className="sel" value={sort} onChange={e => setSort(e.target.value as Sort)}>
                {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <a className="btn" href="/api/portfolio.xlsx" download>{DL}Excel</a>
            </div>
          </div>
          <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="hold-h">
            <table className="pf-table">
              <thead><tr>
                {/* valuation first, so a phone shows CMP, upside, FV and P&L beside the sticky name */}
                <th scope="col">Company</th><th scope="col"><T k="cmp" /></th><th scope="col"><T k="updown">Up/(down)</T></th>
                <th scope="col">Base <T k="fv" /></th><th scope="col"><T k="upnl" /></th><th scope="col"><T k="weight" /></th>
                <th scope="col">Qty</th><th scope="col">Avg cost</th><th scope="col"><T k="mv">Mkt value</T></th><th scope="col"><T k="pe" /></th>
                <th scope="col"><T k="ev_ebitda" /> · <T k="pb" /></th><th scope="col">Flags · results</th><th scope="col"><span className="sr">Actions</span></th>
              </tr></thead>
              <tbody>{rows.map(r => <Row key={r.symbol} r={r} onEdit={() => { setEdit({ symbol: r.symbol, qty: r.qty, cost: r.cost }); formRef.current?.scrollIntoView({ block: 'center' }) }} onRemove={() => remove(r)} />)}</tbody>
              <tfoot><tr className="total">
                <th scope="row">Total</th><td /><td className="ours">{fmt(t.upside, 'pct')}</td><td>{t.fv != null ? money(t.fv) : '–'}</td>
                <td>{money(t.pnl)}</td><td>{t.value != null ? '100.0%' : '–'}</td><td /><td /><td>{money(t.value)}</td>
                <td>{fmt(m.pe.value, 'x')}</td><td /><td>{p.flags} flag{p.flags === 1 ? '' : 's'}</td><td />
              </tr></tfoot>
            </table>
          </div>
          <p className="small-note">CMP: NSE last price kept by this app (Refresh prices); a typed price in a model stays. Mkt value and totals in Rs.
            Base FV: the base case of each company’s saved model; total = Σ quantity × base FV over modelled holdings. P/E, EV/EBITDA
            and P/B at CMP on the last reported year (consolidated; lenders standalone); portfolio figures are <T k="lookthrough">look-through</T>.
            {t.unpriced.length > 0 && <> No CMP yet for {t.unpriced.join(', ')}: they carry no weight until a price is fetched (check the symbol if NSE has none).</>}</p>
        </section>

        <div className="pf-two">
          <section className="blk" aria-labelledby="sec-h">
            <h2 id="sec-h"><T k="sector">Sector</T> exposure</h2>
            <ul className="pf-bars">{p.sectors.map(([s, w, syms]) => (
              <li key={s}><span className="pf-bl">{s}<span className="pf-sym">{syms.join(', ')}</span></span><span className="pf-bar" aria-hidden="true"><i style={{ width: `${Math.max(1, w * 100)}%` }} /></span>
                <b className="num">{pc(w)}</b></li>))}</ul>
          </section>
          <section className="blk" aria-labelledby="conc-h">
            <h2 id="conc-h">Concentration</h2>
            <dl className="pf-conc">
              <div><dt><T k="top5" /></dt><dd className="num">{pc(c.top5)}</dd></div>
              <div><dt><T k="hhi" /></dt><dd className="num">{c.hhi == null ? '–' : money(c.hhi)}</dd></div>
              <div><dt><T k="eff_n" /></dt><dd className="num">{c.effective == null ? '–' : c.effective.toFixed(1)} <span className="small muted">of {c.n}</span></dd></div>
            </dl>
            <p className="small-note">Largest: {[...p.holdings].filter(r => r.weight != null).sort((a, b) => b.weight! - a.weight!).slice(0, 3).map(r => `${r.symbol} ${pc(r.weight)}`).join(', ') || '–'}.</p>
          </section>
        </div>

        {(fresh.length > 0 || p.flags > 0) && <section className="blk" aria-labelledby="look-h">
          <h2 id="look-h">Worth a look</h2>
          <ul className="kpi-list">
            {fresh.map(r => <li key={`n-${r.symbol}`}><span><b>{name(r)}</b>: new results ({r.new_results!.map(x => /^\d{4}-/.test(x) ? qfy(x) : x).join(', ')})</span>
              <a href={pathOf(slugOf(r.id!), 'tracking')}>Results tracking</a></li>)}
            {p.holdings.filter(r => r.flags).sort((a, b) => b.flags! - a.flags!).map(r => <li key={`f-${r.symbol}`}>
              <span><b>{name(r)}</b>: {r.flags} red flag{r.flags! > 1 ? 's' : ''}{r.weight != null ? ` · weight ${pc(r.weight)}` : ''}</span>
              <a href={pathOf(slugOf(r.id!), 'risks')}>Risks & forensics</a></li>)}
          </ul>
        </section>}
      </>}

      <section className="blk" aria-labelledby="add-h">
        <h2 id="add-h">{edit && p.holdings.some(h => h.symbol === edit.symbol) ? `Edit ${edit.symbol}` : 'Add a holding'}</h2>
        <HoldingForm key={edit ? `${edit.symbol}-${edit.qty}-${edit.cost}` : 'new'} formRef={formRef} edit={edit} models={models}
          onCancel={() => setEdit(null)}
          onSave={async h => {
            const editing = edit && p.holdings.some(x => x.symbol === edit.symbol)
            const held = list().find(x => x.symbol === h.symbol)
            const next = editing ? list().map(x => x.symbol === h.symbol ? h : x) : [...list(), h]
            const ok = await save(next, editing ? `Saved ${h.symbol}.` : held ? `Added to ${h.symbol} at the weighted average cost.` : `Added ${h.symbol}.`)
            if (ok) setEdit(null)
            return ok
          }} />
        <Paste onDone={x => { setP(x); setMsg('Holdings saved from the pasted lines.') }} />
        {msg && <p className="small" role="status">{msg}</p>}
      </section>
      <footer className="foot">
        <p>Rules only: CMPs are the last NSE prices kept, fair values come from each saved model, and nothing here calls the AI or
          changes a model. The Excel export holds these figures as values.</p>
      </footer>
    </main>
  )
}

function Kpi({ k, v, sub, tone: t = '' }: { k: ReactNode; v: string; sub?: string; tone?: string }) {
  return <div className="pf-kpi"><dt>{k}</dt><dd className={`num ${t}`}>{v}</dd>{sub && <dd className="small muted">{sub}</dd>}</div>
}

/** One holding: the company (or "no model yet"), position, value against base FV, multiples, flags, results. */
function Row({ r, onEdit, onRemove }: { r: HoldingRow; onEdit: () => void; onRemove: () => void }) {
  const slug = r.id ? slugOf(r.id) : null
  const m = r.multiples
  return (
    <tr>
      <th scope="row">{slug ? <a href={pathOf(slug, 'summary')}>{name(r)}</a> : <span>{r.name ? name(r) : r.symbol}</span>}
        <span className="pf-sym">{r.symbol}{r.lender ? ' · lender' : ''}</span></th>
      <td className="mkt">{r.price != null ? rs(r.price) : '–'}</td>
      {!slug ? <td colSpan={2} className="pf-none">No model yet · <a href={`/add?symbol=${encodeURIComponent(r.symbol)}`}>Build model</a></td>
        : r.fv == null ? <td colSpan={2} className="pf-none">No FV: {r.why ?? 'see Valuation'} · <a href={pathOf(slug, 'valuation')}>Valuation</a></td>
        : <><td className="ours">{fmt(r.upside, 'pct')}<span className="pf-sub"><Verdict price={r.price} values={{ bear: r.bear, base: r.fv, bull: r.bull }} words={false} /></span></td><td className="ours">{rs(r.fv)}</td></>}
      <td>{money(r.pnl)}<span className="pf-sub">{r.pnl != null && r.invested ? fmt(r.pnl / r.invested, 'pct') : ''}</span></td>
      <td>{fmt(r.weight, 'pct')}</td>
      <td>{r.qty % 1 ? dec2(r.qty) : money(r.qty)}</td>
      <td>{rs(r.cost)}</td>
      <td>{money(r.value)}</td>
      <td>{fmt(m?.pe, 'x')}</td>
      <td>{r.lender ? <>{fmt(m?.pb, 'x')} <span className="pf-sub">P/B</span></> : fmt(m?.ev_ebitda, 'x')}</td>
      <td className="pf-look">{slug ? <>
        <a href={pathOf(slug, 'risks')} className={r.flags ? 'warn' : undefined}>{r.flags ? `${r.flags} flag${r.flags > 1 ? 's' : ''}` : 'No flags'}</a>
        {r.new_results?.length ? <a href={pathOf(slug, 'tracking')}><b>new results</b></a>
          : r.quarter?.status ? <a href={pathOf(slug, 'tracking', '', null, 'quarter')} className={r.quarter.status === 'behind' ? 'warn' : undefined}>{r.quarter.period}: {Q_WORD[r.quarter.status].toLowerCase()}</a> : null}
      </> : '–'}</td>
      <td><Menu label={`More for ${r.symbol}`} items={[{ label: 'Edit quantity or cost', onClick: onEdit }, { label: `Remove ${r.symbol}`, onClick: onRemove, danger: true }]} /></td>
    </tr>
  )
}

/** Symbol, quantity and average cost; the symbol list suggests the companies already modelled. */
function HoldingForm({ edit, models, onSave, onCancel, formRef }: {
  edit: Holding | null; models: ModelSummary[] | null; onSave: (h: Holding) => Promise<boolean>; onCancel: () => void
  formRef: React.RefObject<HTMLFormElement>
}) {
  const [sym, setSym] = useState(edit?.symbol ?? '')
  const [qty, setQty] = useState(edit ? String(edit.qty) : '')
  const [cost, setCost] = useState(edit ? String(edit.cost) : '')
  const [bad, setBad] = useState<string | null>(null)
  const symRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (edit) symRef.current?.focus() }, [edit])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const q = num(qty), c = num(cost), s = sym.trim().toUpperCase()
    if (!s) return setBad('Enter an NSE symbol (or a BSE scrip code).')
    if (!(q > 0)) return setBad('Quantity must be a number above 0.')
    if (!(c >= 0)) return setBad('Average cost must be a number, Rs per share.')
    setBad(null)
    if (await onSave({ symbol: s, qty: q, cost: c }) && !edit) { setSym(''); setQty(''); setCost(''); symRef.current?.focus() }
  }
  const syms = [...new Set((models ?? []).map(m => m.symbol).filter((s): s is string => !!s))]
  return (
    <form ref={formRef} className="pf-form" onSubmit={submit} noValidate>
      <label>Symbol<input ref={symRef} value={sym} onChange={e => setSym(e.target.value)} list="pf-syms" autoComplete="off" spellCheck={false}
        placeholder="e.g. TCS" aria-describedby={bad ? 'pf-bad' : undefined} readOnly={!!edit} /></label>
      <datalist id="pf-syms">{syms.map(s => <option key={s} value={s} />)}</datalist>
      <label>Quantity<input value={qty} onChange={e => setQty(e.target.value)} inputMode="decimal" autoComplete="off" placeholder="e.g. 100" /></label>
      <label>Avg cost, Rs<input value={cost} onChange={e => setCost(e.target.value)} inputMode="decimal" autoComplete="off" placeholder="e.g. 3,250" /></label>
      <span className="pf-act"><button type="submit" className="primary">{edit ? 'Save' : 'Add holding'}</button>
        {edit && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}</span>
      {bad && <p id="pf-bad" className="error" role="alert">{bad}</p>}
      {!edit && <p className="small muted pf-hint">A symbol you already hold adds to it at the weighted average cost.</p>}
    </form>
  )
}

/** CSV paste: "symbol,qty,cost" per line, added to the holdings or replacing them; any bad line saves nothing. */
function Paste({ onDone }: { onDone: (p: PortfolioView) => void }) {
  const [text, setText] = useState('')
  const [replace, setReplace] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true); setErr(null)
    try { onDone(await api<PortfolioView>('/api/portfolio/paste', postJson({ text, replace }))); setText('') }
    catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }
  return (
    <details className="fold pf-paste">
      <summary>Paste holdings as CSV <span className="small muted">symbol,qty,cost, one per line</span></summary>
      <label className="sr" htmlFor="pf-csv">Holdings, one per line: symbol, quantity, average cost</label>
      <textarea id="pf-csv" rows={6} value={text} onChange={e => setText(e.target.value)} spellCheck={false}
        placeholder={'symbol,qty,cost\nTCS,100,3200\nHDFCBANK,250,"1,610.50"'} aria-describedby={err ? 'pf-csv-err' : undefined} />
      <fieldset className="pf-mode"><legend className="sr">With the current holdings</legend>
        <label><input type="radio" name="pf-mode" checked={!replace} onChange={() => setReplace(false)} /> Add to holdings</label>
        <label><input type="radio" name="pf-mode" checked={replace} onChange={() => setReplace(true)} /> Replace all holdings</label>
      </fieldset>
      <button type="button" className="btn" onClick={go} disabled={busy || !text.trim()}>{replace ? 'Replace holdings' : 'Add these'}</button>
      {err && <p id="pf-csv-err" className="error" role="alert">{err}</p>}
      <p className="small-note">Comma or tab separated (a spreadsheet copy works); a broker’s holdings export pastes as it is, header included (Instrument, Qty., Avg. cost; other columns ignored); without a header, put numbers with commas in quotes.</p>
    </details>
  )
}
