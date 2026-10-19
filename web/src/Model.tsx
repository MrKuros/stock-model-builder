import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Chart from './Chart'
import { growth, month } from './Statements'
import DraftPanel, { failing, latest, path, useDraft } from './Draft'
import { Checks, useAi } from './Sources'
import { Confirm, Next, PageHead, Src, Stepper } from './Shell'
import { shortName } from './Note'
import { useHref } from './route'
import {
  DOC_KINDS, NAMES, SHIFT, copyBase, defaultPaths, fmt, flat, groupKeys, money, rs, seed, type Impact,
  type Kind, type ModelDoc, type MovedOut, type Parsed, type Path, type Paths, type Projection, type Proposal, type Row, type Scenario, type Sources, type Ttm,
} from './lib'

/** Each input in plain words first, the term in brackets; the line under it says what it is a share of. */
export const PLAIN: Record<string, [string, string]> = {
  growth: ['Sales growth', 'a year, every forecast year'],
  ebitda_margin: ['Operating margin (EBITDA)', 'operating profit as a share of sales'],
  capex_pct: ['Capital spending (capex)', 'spend on new plant and equipment, % of sales'],
  tax_rate: ['Tax rate', '% of profit before tax'],
  payout: ['Share of profit paid out (payout)', 'paid as dividends'],
  dso: ['Days customers take to pay (receivable days)', 'days of sales waiting to be collected'],
  dpo: ['Days we take to pay suppliers (payable days)', 'days of sales owed to suppliers'],
  dio: ['Days of stock held (inventory days)', 'days of sales sitting as stock'],
  cogs_pct: ['Cost of goods (COGS)', 'materials and purchases, % of sales'],
  dep_pct: ['Wear and tear (depreciation)', '% of last year’s plant written off'],
  int_rate: ['Interest rate on borrowings', '% of last year’s debt and leases'],
  oi_pct: ['Other income', 'treasury and non-operating income, % of sales'],
  mi_pct: ['Minority and associates’ share', 'associates’ profit in, minority holders’ share out'],
  oca_pct: ['Other current assets', 'advances and deposits, % of sales'],
  ol_pct: ['Other liabilities', 'provisions and advances received, % of sales'],
  debt_change: ['Planned borrowing change', 'Rs crore a year; shortfalls are borrowed anyway'],
}
export const inputName = (k: string, fallback = k) => PLAIN[k]?.[0] ?? fallback
const TOP = ['growth', 'ebitda_margin']
const ALSO = ['capex_pct', 'tax_rate', 'payout', 'dso', 'dpo', 'dio']
// how default_assumptions() gets each default (model.py); the arithmetic is the reported years shown beside it
const RULE: Record<string, string> = {
  growth: 'Revenue CAGR over the last 3 years (every year, exclusions ignored)',
  oi_pct: 'Median of the last 3 years’ other income % revenue (drops a one-off)',
  capex_pct: 'Median of the last 3 years’ capex % revenue',
  debt_change: 'Held flat: no planned new borrowing',
  tax_rate: '3-yr ratio of sums: tax ÷ profit before tax, kept between 0% and 50%',
  payout: '3-yr ratio of sums: dividend ÷ net profit, kept between 0% and 100%',
  mi_pct: '3-yr ratio of sums, kept between −50% and 50%',
}
const ruleOf = (k: string) => RULE[k] ?? '3-yr ratio of sums (each year weighted by its size)'
// payout, other income, interest and minorities don't move a cash-flow-to-firm value (model.IMPACT)
const NO_VALUE = new Set(['payout', 'oi_pct', 'int_rate', 'mi_pct', 'debt_change'])
// defaults an attached annual filing or an approved note can move (payables, cash-flow capex, a business moved out);
// inventory days and COGS come from the export
export const UPGRADED = ['dpo', 'ol_pct', 'capex_pct', 'ebitda_margin']
/** "Payable days" -> "payable days", "EBITDA margin" stays. */
export const lower = (s: string) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1))
/** A default the filings moved, offered to all three cases in one click: the case's value now, the new default. */
export interface Upgrade { key: string; label: string; kind: Kind; from: number; to: number }
const METRICS: [string, string, (r: Row) => number | null][] = [
  ['revenue', 'Sales', r => r.revenue],
  ['ebitda', 'Operating profit', r => r.ebitda],
  ['pat', 'Net profit', r => r.pat],
  ['fcf', 'Free cash flow', r => r.fcf],
  ['net_cash', 'Net cash', r => (r.cash ?? 0) + (r.investments ?? 0) - (r.borrowings ?? 0) - (r.lease ?? 0)],
]

/** "−Rs 87 per 1 point": the central value's slope from the one-step runs (model.drivers_impact), in the input's unit. */
export function perStep(k: string, impact: Impact[] | undefined, kind: Kind): string | null {
  if (NO_VALUE.has(k)) return 'doesn’t move the value'
  const d = impact?.find(x => x.key === k)
  if (!d || d.down == null || d.up == null) return null
  const unit = kind === 'pct' ? 0.01 : 10
  const s = ((d.up - d.down) / (2 * d.step)) * unit
  if (Math.abs(s) < 0.5) return 'barely moves the value'
  return `${s < 0 ? '−' : '+'}Rs ${Math.abs(s) >= 10 ? money(Math.round(Math.abs(s))) : rs(Math.abs(s))} per ${kind === 'pct' ? '1 point' : '10 days'}`
}

interface Props {
  parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; projection: Projection | null
  anchor: string; upgrades: Upgrade[]; onApply: () => void; onKeep: () => void
}

/** Our forecast: the inputs in three tiers, each row opening in place with its editor; the AI suggestions; the
 * projection the inputs produce. */
export default function ModelView({ parsed, doc, setDoc, projection, anchor, upgrades, onApply, onKeep }: Props) {
  const href = useHref()
  const ai = useAi()
  const { company, years: histYears, ratios, defaults, drivers } = parsed
  const { n, active, scenarios } = doc
  const a = scenarios[active]
  const setA = (f: (p: Paths) => Paths) =>
    setDoc(d => ({ ...d, scenarios: { ...d.scenarios, [d.active]: f(d.scenarios[d.active]) } }))
  const seeded = useMemo(() => seed(defaultPaths(defaults, parsed.default_ends)), [defaults, parsed.default_ends])
  const byKey = Object.fromEntries(drivers.map(d => [d[0], d]))
  const [open, setOpen] = useState<string | null>(() => (byKey[anchor] ? anchor : null))
  useEffect(() => { if (byKey[anchor]) setOpen(anchor) }, [anchor]) // eslint-disable-line react-hooks/exhaustive-deps
  const name = shortName(company.name)

  const hist = parsed.hist ?? company.hist
  const nHist = hist.length
  const sources = parsed.sources
  const proj = projection?.scenarios[active].length === n ? projection.scenarios[active] : null
  const projYears = proj ? projection!.years : []
  const v = proj ? projection!.valuation : null
  const onCogs = sources?.basis === 'cogs'
  const nonZero = (k: string) => !!a[k] && (a[k].start !== 0 || (a[k].end ?? 0) !== 0)
  const shown = (k: string) => !!byKey[k] && (!sources || (k === 'cogs_pct' ? onCogs
    : k === 'dpo' ? sources.used.payables.length > 0 || nonZero(k) : true))
  const offIdx = proj ? proj.findIndex(r => Math.abs(r.chk_bs ?? 0) >= 0.5 || Math.abs(r.chk_cash ?? 0) >= 0.5) : -1
  const off = offIdx >= 0 ? Math.max(Math.abs(proj![offIdx].chk_bs ?? 0), Math.abs(proj![offIdx].chk_cash ?? 0)) : 0
  const roundingOnly = offIdx === 0 && off <= 2 && proj!.slice(1).every(r => Math.abs(r.chk_bs ?? 0) < 0.5 && Math.abs(r.chk_cash ?? 0) < 0.5)
  const borrowed = proj ? proj.reduce((s, r) => s + (r.revolver ?? 0), 0) : 0
  const draft = useDraft(doc, setDoc)
  const waiting = latest(doc).some(p => p.status === 'proposed')
  const [suggest, setSuggest] = useState(waiting)
  const [resetAsk, setResetAsk] = useState(false)
  const srcOf = (k: string) => doc.assumption_sources[active]?.[k]
  const propOf = (id: string | undefined) => (id && id !== 'manual' && id !== 'history' ? doc.proposals.find(p => p.id === id) : undefined)
  const docOf = (p: Proposal) => {
    const r = doc.reports.find(x => x.id === p.report)
    return r ? `${r.year} ${DOC_KINDS[r.kind ?? 'annual'].toLowerCase()}` : p.source.file ?? 'a document'
  }
  const valueOf = (k: string) => a[k] ?? flat(seeded[active][k].start)
  const isYou = (k: string) => {
    const p = valueOf(k), d = seeded[active][k]
    return Math.abs(p.start - (d?.start ?? 0)) > 1e-9 || (p.end == null) !== (d?.end == null) || (p.end != null && Math.abs(p.end - d!.end!) > 1e-9)
  }
  const kindOf = (k: string) => byKey[k][2] as Kind
  /** The source in words: yours (yellow), from an approved AI suggestion (yellow, cited), or the rule (blue). */
  const srcWords = (k: string): ReactNode => {
    const s = srcOf(k), p = propOf(s), kind = kindOf(k)
    if (p) return <Src kind="you">You set this · from {docOf(p)} p. {p.source.page}</Src>
    if (s === 'manual' || (s !== 'history' && isYou(k))) return <Src kind="you">You set this · rule said {path(seeded[active][k], kind)}</Src>
    return <Src kind="rule">Rule: {k === 'debt_change' ? 'no new borrowing' : k === 'growth' ? 'last 3 years’ growth' : 'last 3 years'}</Src>
  }
  const impact = v?.note?.impact
  const be = v?.note?.breakevens ?? {}
  const needOf = (k: string) => (k === 'growth' ? v?.scenarios[active].implied_growth ?? null
    : k === 'ebitda_margin' && active === 'base' ? be.ebitda_margin?.value ?? null : null)
  const resetActive = () => setDoc(d => ({ ...d, scenarios: { ...d.scenarios, [active]: seeded[active] },
    assumption_sources: { ...d.assumption_sources, [active]: {} } }))
  const dioUsed = (ratios[nHist - 1]?.dio ?? 0) >= 1
  const also = ALSO.filter(k => shown(k) && (k !== 'dio' || dioUsed))
  const rest = drivers.map(d => d[0]).filter(k => shown(k) && !TOP.includes(k) && !also.includes(k))
  const ownCount = drivers.map(d => d[0]).filter(k => shown(k) && (srcOf(k) === 'manual' || !!propOf(srcOf(k)) || (srcOf(k) !== 'history' && isYou(k)))).length

  const row = (k: string, big = false) => (
    <DriverRow key={k} k={k} big={big} kind={kindOf(k)} open={open === k} onToggle={() => setOpen(o => (o === k ? null : k))}
      value={valueOf(k)} rule={seeded[active][k]} you={!!propOf(srcOf(k)) || srcOf(k) === 'manual' || (srcOf(k) !== 'history' && isYou(k))}
      src={srcWords(k)} history={ratios.map(r => r[k])} years={histYears} effect={perStep(k, impact, kindOf(k))} need={needOf(k)} name={name}
      onChange={p => setA(prev => ({ ...prev, [k]: p }))}>
      <RuleFold k={k} kind={kindOf(k)} rule={seeded[active][k]} active={active} parsed={parsed} doc={doc} />
      {k === 'growth' && <MovedOutCard doc={doc} setDoc={setDoc} year={histYears[nHist - 1]} revenue={hist[nHist - 1].revenue ?? 0} used={sources?.moved_out ?? null} />}
      <Linked k={k} parsed={parsed} />
      <Pending k={k} doc={doc} kind={kindOf(k)} active={active} busy={!!draft.busy} docOf={docOf} current={valueOf(k)}
        onUse={p => draft.accept([p])} onKeep={p => draft.reject(p)} />
    </DriverRow>
  )

  return (
    <>
      <PageHead label="Work on it · Our forecast" title="Our forecast"
        purpose={<>The assumptions behind our value. Rules set each one from {name}’s own last three years; change any of them and the
          value updates as you type. Recalculating never calls AI.</>}
        answer={v && v.scenarios[active].per_share != null
          ? <>With these inputs one share is worth <span className="num ours">Rs {rs(v.scenarios[active].per_share!)}</span> in the {NAMES[active].toLowerCase()} case.
            {ownCount ? <> {ownCount === 1 ? 'One number is' : `${ownCount} numbers are`} yours; the rest come from the rules.</> : <> Every number comes from the rules.</>}</>
          : <>These inputs don’t give a value yet{v?.scenarios[active].error ? `: ${v.scenarios[active].error.replace(/^./, c => c.toLowerCase())}` : '.'}</>} />

      <div className="f-tool">
        <p>Editing the <b>{NAMES[active]}</b> case <span className="small muted">(change it in the bar at the top)</span></p>
        <button type="button" className="btn" aria-expanded={suggest} aria-controls="draft" onClick={() => setSuggest(s => !s)}>
          Suggest from documents <span className="ai-tag">AI</span></button>
      </div>
      <p className="status-line" aria-live="polite">
        {proj && offIdx < 0 && <span className="ok">Balance sheet balances in every forecast year</span>}
        {offIdx >= 0 && roundingOnly && <span className="ok">Balance sheet balances ({projYears[0]} cash is off by Rs {money(off)} cr from rounding in the reported figures)</span>}
      </p>
      {offIdx >= 0 && !roundingOnly && <div className="notice-bar bad inline" role="alert">The balance sheet doesn’t balance in {projYears[offIdx]} by Rs {money(off)} crore.
        Usually an input far outside its record causes it; reset the last one you changed.</div>}

      {upgrades.length > 0 && (
        <div className="banner" role="status">
          <p>The rules’ figures moved after the filings or approved notes changed:{' '}
            {upgrades.map((u, i) => <span key={u.key}>{i > 0 && '; '}{lower(inputName(u.key, u.label))} {fmt(u.from, u.kind)} → <b className="num">{fmt(u.to, u.kind)}</b></span>)}.
            Your inputs haven’t changed.</p>
          <div className="banner-act"><button type="button" className="btn" onClick={onApply}>Use the new figures</button>
            <button type="button" className="link" onClick={onKeep}>Keep mine</button></div>
        </div>
      )}

      {suggest && <div id="draft"><DraftPanel parsed={parsed} doc={doc} d={draft} ai={ai} href={href('documents', 'add')} /></div>}

      <section className="f-tier" aria-labelledby="t1-h" id="inputs">
        <h2 id="t1-h">The two that move the value most</h2>
        <p className="why">Sales growth and operating margin move the value more than anything else you can set here.</p>
        <ul className="drows big">{TOP.filter(shown).map(k => row(k, true))}</ul>
      </section>
      <section className="f-tier" aria-labelledby="t2-h">
        <h2 id="t2-h">Also used <span className="cnt">{also.length}</span></h2>
        <ul className="drows">{also.map(k => row(k))}</ul>
      </section>
      <details className="fold f-more" open={rest.includes(open ?? '') || undefined}>
        <summary><span><b>Accounting details ({rest.length})</b> · {rest.map(k => lower(inputName(k))).join(', ')}: all set by the rules unless you change them</span></summary>
        <ul className="drows">{rest.map(k => row(k))}</ul>
      </details>
      <details className="fold f-more">
        <summary><span><b>Copy or reset the cases</b> · cautious and hopeful start from central: sales growth ± 3 points, margin ± 1.5 points</span></summary>
        <div className="next-act">
          <button type="button" className="btn" onClick={() => copyBase(setDoc, scenarios)}>Copy central to cautious and hopeful</button>
          <button type="button" className="btn" onClick={() => setResetAsk(true)}>Reset {NAMES[active].toLowerCase()} to the rules’ figures</button>
        </div>
      </details>
      <Confirm open={resetAsk} title={`Reset the ${NAMES[active].toLowerCase()} case to the rules’ figures?`}
        body={<>Every input in this case goes back to what the rules set{ownCount ? <>, including the {ownCount} you set</> : null}. You can Undo it straight after.</>}
        yes="Reset to the rules" onYes={resetActive} onClose={() => setResetAsk(false)} />

      <Produces parsed={parsed} projection={projection} active={active} n={n} borrowed={borrowed} />
      <Next lead="See every line the forecast produces, year by year."><a className="btn" href={href('statements')}>See the full statements</a></Next>
    </>
  )
}

/** One input: closed, a row (name, history, value and its source, effect on the value); open, the editor in place. */
function DriverRow({ k, big, kind, open, onToggle, value, rule, you, src, history, years, effect, need, name, onChange, children }: {
  k: string; big: boolean; kind: Kind; open: boolean; onToggle: () => void; value: Path; rule: Path; you: boolean; src: ReactNode
  history: (number | null)[]; years: string[]; effect: string | null; need: number | null; name: string; onChange: (p: Path) => void; children: ReactNode
}) {
  const [label, sub] = PLAIN[k] ?? [k, '']
  const gradual = value.end != null
  const changed = gradual !== (rule.end != null) || Math.abs(value.start - rule.start) > 1e-9 || (gradual && Math.abs((value.end ?? 0) - (rule.end ?? 0)) > 1e-9)
  const known = history.map((x, i) => [x, years[i]] as const).filter((p): p is readonly [number, string] => p[0] != null && Number.isFinite(p[0]))
  const hi = known.length ? known.reduce((m, p) => (p[0] > m[0] ? p : m)) : null
  const lo = known.length ? known.reduce((m, p) => (p[0] < m[0] ? p : m)) : null
  const what = lower(label.replace(/ \(.*\)$/, ''))
  const guard = hi && value.start > hi[0] + 1e-9 ? <><b>Higher than any year on record.</b> {name}’s highest {what} was {fmt(hi[0], kind)} in {hi[1]}. Fine if you have a reason; the research note will mention it.</>
    : lo && value.start < lo[0] - 1e-9 ? <><b>Lower than any year on record.</b> {name}’s lowest {what} was {fmt(lo[0], kind)} in {lo[1]}.</> : null
  const id = `in-${k}`
  return (
    <li className={`drow${open ? ' open' : ''}${big ? ' big' : ''}`} id={`a-${k}`}>
      <button type="button" className="dr-head" aria-expanded={open} aria-controls={`${id}-ed`} onClick={onToggle}>
        <span className="dr-name"><b>{label}</b><span className="small muted">{sub}</span></span>
        <Spark hist={history} used={value} />
        <span className="dr-val"><b className={`num${you ? ' you-hl' : ' ours'}`}>{path(value, kind)}</b>{src}</span>
        <span className="dr-eff small muted">{effect ? <>{effect}</> : null}</span>
        <span className="dr-edit">{open ? 'Close' : 'Edit'}</span>
      </button>
      {open && <div className="dr-ed" id={`${id}-ed`}>
        <div className="dr-set">
          {gradual
            ? <span className="dr-grad">
                <label className="small" htmlFor={id}>{years.length ? 'First forecast year' : 'Start'}</label>
                <Stepper id={id} label={`${label}, first forecast year`} kind={kind} value={value.start} you={you} onChange={x => onChange({ start: x, end: value.end })} />
                <span aria-hidden="true">→</span>
                <label className="small" htmlFor={`${id}-end`}>Last forecast year</label>
                <Stepper id={`${id}-end`} label={`${label}, last forecast year`} kind={kind} value={value.end!} you={you} onChange={x => onChange({ start: value.start, end: x })} />
              </span>
            : <Stepper id={id} label={label} kind={kind} value={value.start} you={you} onChange={x => onChange({ start: x, end: null })} />}
          <span className="small">{changed
            ? <><Src kind="you">You set this</Src> Rule said {path(rule, kind)} · <button type="button" className="link" onClick={() => onChange(rule)}>Reset to {path(rule, kind)}</button></>
            : <>This is the rule’s figure.</>}</span>
        </div>
        <Track label={label} kind={kind} value={value.start} rule={rule.start} known={known} need={need} onChange={x => onChange({ start: x, end: value.end })} />
        {guard && <p className="guard">{guard}</p>}
        <label className="small grad-q"><input type="checkbox" checked={gradual}
          onChange={e => onChange(e.target.checked ? { start: rule.start, end: value.start } : { start: value.end ?? value.start, end: null })} />
          {' '}Change it gradually: move from the rule’s {fmt(rule.start, kind)} in the first forecast year to {fmt(value.end ?? value.start, kind)} by the last, instead of all at once</label>
        {children}
      </div>}
    </li>
  )
}

/** The drag track: the record band, each reported year as a dot (stacked where they'd overlap), what the price needs
 * as a dashed line, and the knob (a slider: arrow keys, Shift for bigger steps, Home for the rule). */
function Track({ label, kind, value, rule, known, need, onChange }: {
  label: string; kind: Kind; value: number; rule: number; known: (readonly [number, string])[]; need: number | null; onChange: (v: number) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [dom, setDom] = useState<[number, number] | null>(null) // fixed while dragging, so the scale doesn't move under the pointer
  // ponytail: clip one-off spikes (a demerger year's 400% growth) so they don't flatten the track
  const clip = (x: number) => (kind === 'pct' ? Math.max(-1, Math.min(2, x)) : x)
  const vals = [...known.map(p => clip(p[0])), value, rule, ...(need == null ? [] : [clip(need)])]
  let lo = Math.min(...vals), hi = Math.max(...vals)
  const min = kind === 'pct' ? 0.04 : kind === 'days' ? 10 : 50
  if (hi - lo < min) { const m = (hi + lo) / 2; lo = m - min / 2; hi = m + min / 2 }
  const pad = (hi - lo) * 0.08
  const [l, h] = dom ?? [lo - pad, hi + pad]
  const at = (x: number) => Math.max(0, Math.min(100, ((x - l) / (h - l)) * 100))
  const snap = (x: number) => Math.round(x / (kind === 'pct' ? 0.001 : 1)) * (kind === 'pct' ? 0.001 : 1)
  const fromX = (cx: number, d: [number, number]) => {
    const r = box.current!.getBoundingClientRect()
    onChange(snap(d[0] + Math.max(0, Math.min(1, (cx - r.left) / r.width)) * (d[1] - d[0])))
  }
  const step = kind === 'pct' ? 0.001 : 1
  // dots that would sit on top of each other go up a row
  const put: { p: number; row: number }[] = []
  const dots = known.map(([x, y], i) => {
    const p = at(clip(x))
    let row = 0
    while (put.some(d => d.row === row && Math.abs(d.p - p) < 1.8)) row++
    put.push({ p, row })
    return { p, y, x, row: Math.min(row, 3), last: i >= known.length - 3 }
  })
  const band = known.length ? [Math.min(...known.map(p => clip(p[0]))), Math.max(...known.map(p => clip(p[0])))] : null
  return (
    <div className="track-w">
      <div className="track" ref={box}
        onPointerDown={e => { const d: [number, number] = [l, h]; setDom(d); e.currentTarget.setPointerCapture(e.pointerId); if (e.pointerType !== 'touch') fromX(e.clientX, d) }}
        onPointerMove={e => { if (dom) fromX(e.clientX, dom) }} onPointerUp={() => setDom(null)} onPointerCancel={() => setDom(null)}>
        <i className="t-ax" />
        {band && <i className="t-band" style={{ left: `${at(band[0])}%`, width: `${Math.max(0.5, at(band[1]) - at(band[0]))}%` }} />}
        {dots.map(d => <i key={d.y} className={`t-dot${d.last ? ' last' : ''}`} style={{ left: `${d.p}%`, top: `calc(50% - 4px - ${d.row * 9}px)` }} title={`${d.y}: ${fmt(d.x, kind)}`} />)}
        {need != null && <i className="t-need" style={{ left: `${at(clip(need))}%` }}><span>Price needs {fmt(need, kind)}</span></i>}
        <span className="t-knob" role="slider" tabIndex={0} aria-label={`${label}, drag or use the arrow keys`} style={{ left: `${at(value)}%` }}
          aria-valuemin={+((l) * (kind === 'pct' ? 100 : 1)).toFixed(1)} aria-valuemax={+((h) * (kind === 'pct' ? 100 : 1)).toFixed(1)}
          aria-valuenow={+(value * (kind === 'pct' ? 100 : 1)).toFixed(1)} aria-valuetext={fmt(value, kind)}
          onKeyDown={e => {
            const s = step * (e.shiftKey ? 10 : 1)
            const m: Record<string, number> = { ArrowUp: value + s, ArrowRight: value + s, ArrowDown: value - s, ArrowLeft: value - s, Home: rule }
            if (e.key in m) { e.preventDefault(); onChange(snap(m[e.key])) }
          }}><span>{fmt(value, kind)}</span></span>
      </div>
      {known.length > 0 && <p className="small muted t-cap">Dots: {known[0][1]}–{known[known.length - 1][1].slice(-2)}, {fmt(band![0], kind)} to {fmt(band![1], kind)} (the band).
        Last three: {known.slice(-3).map(([x, y]) => `${y} ${fmt(x, kind)}`).join(' · ')}. Drag, type, or use ← →.</p>}
    </div>
  )
}

/** "How the rule got 26.7%": the rule and the year-by-year arithmetic. */
function RuleFold({ k, kind, rule, active, parsed, doc }: { k: string; kind: Kind; rule: Path; active: Scenario; parsed: Parsed; doc: ModelDoc }) {
  const { years: histYears, ratios, sources } = parsed
  const hist = parsed.hist ?? parsed.company.hist
  const used = histYears.filter(y => !doc.excluded_years.includes(y)).slice(-3) // mirrors default_assumptions(years=3)
  return (
    <details className="sub-fold">
      <summary>How the rule got {path(rule, kind)}</summary>
      <p className="small">{sources?.drivers[k] ?? ruleOf(k)}.</p>
      {k !== 'debt_change' && <p className="arith num">
        {(k === 'growth' ? histYears.slice(-4) : used).map(y => {
          const i = histYears.indexOf(y)
          return <span key={y}>{y} {k === 'growth' ? money(hist[i].revenue) : fmt(ratios[i][k], kind)}</span>
        })}
        <span className="ours">= {fmt(rule.start, kind)}{active !== 'base' && SHIFT[k] ? ` (${NAMES[active].toLowerCase()}: central ${active === 'bull' ? '+' : '−'} ${+(SHIFT[k] * 100).toFixed(2)} points)` : ''}{rule.end != null ? `, easing to ${fmt(rule.end, kind)} by the last year (a fast grower)` : ''}</span>
      </p>}
      <p className="small dim">{k === 'growth' ? 'Sales, Rs crore' : 'Each year as reported'}{doc.excluded_years.length ? `; left out: ${doc.excluded_years.join(', ')}` : ''}.</p>
    </details>
  )
}

/** "Receivable days are a warning sign: see why", when a rule lit on this input. */
function Linked({ k, parsed }: { k: string; parsed: Parsed }) {
  const href = useHref()
  const recent = parsed.years.slice(-3)
  const odd = parsed.oneoffs.find(o => o.metric === k && recent.includes(o.year))
  const lit = (parsed.rule_checks ?? []).find(c => c.id === k && (c.status === 'red' || c.status === 'amber'))
  if (!odd && !lit) return null
  return <p className="small linked">{odd ? <>{odd.year} stands out for this input ({odd.note.replace(/^./, c => c.toLowerCase())}); the rule’s figure may carry it.{' '}
    <a href={href('risks', 'unusual')}>See why</a></>
    : <>{inputName(k)} is a warning sign: {lit!.fact.replace(/^./, c => c.toLowerCase())}. <a href={href('risks', 'signs')}>See why</a></>}</p>
}

/** An AI suggestion waiting for this input: purple until you Use it. */
function Pending({ k, doc, kind, active, busy, docOf, current, onUse, onKeep }: {
  k: string; doc: ModelDoc; kind: Kind; active: Scenario; busy: boolean; docOf: (p: Proposal) => string; current: Path
  onUse: (p: Proposal) => void; onKeep: (p: Proposal) => void
}) {
  const p = latest(doc).find(x => x.field === k && x.status === 'proposed' && !x.from_history)
  if (!p) return null
  const v = p.value as Record<Scenario, Path>, bad = failing(p)
  return (
    <div className="ai-sug">
      <p><Src kind="ai">AI suggests</Src> <b className="num">{path(v[active], kind)}</b> <span className="small muted">({NAMES[active].toLowerCase()} case) from {docOf(p)} p. {p.source.page}</span></p>
      {p.source.quote && <blockquote className="prop-quote serif">“{p.source.quote}”</blockquote>}
      <Checks checks={p.checks} />
      <div className="next-act">
        <button type="button" className="btn" onClick={() => onUse(p)} disabled={bad} aria-disabled={busy}>Use {path(v[active], kind)}</button>
        <button type="button" className="link" onClick={() => onKeep(p)}>Keep mine ({path(current, kind)})</button>
      </div>
    </div>
  )
}

/** History as dots, the value used as a stroke to the right of the last year. */
function Spark({ hist, used }: { hist: (number | null)[]; used: { start: number; end: number | null } }) {
  const W = 120, H = 26, HE = 92
  const xs = hist.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null && Number.isFinite(p[1]))
  const vals = [...xs.map(p => p[1]), used.start, used.end ?? used.start]
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
  const y = (v: number) => 3 + (1 - (v - lo) / (hi - lo)) * (H - 6)
  const x = (i: number) => 3 + (hist.length > 1 ? (i / (hist.length - 1)) * (HE - 6) : 0)
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polyline points={xs.map(([i, v]) => `${x(i)},${y(v)}`).join(' ')} />
      {xs.map(([i, v]) => <circle key={i} cx={x(i)} cy={y(v)} r={1.6} />)}
      <line className="sep" x1={HE + 2} x2={HE + 2} y1={1} y2={H - 1} />
      <line className="use" x1={HE + 6} x2={W - 3} y1={y(used.start)} y2={y(used.end ?? used.start)} />
    </svg>
  )
}

/** What the forecast produces: the sentence, the three cases' last year, and the chart tabs. */
function Produces({ parsed, projection, active, n, borrowed }: { parsed: Parsed; projection: Projection | null; active: Scenario; n: number; borrowed: number }) {
  const { company, years: histYears } = parsed
  const hist = parsed.hist ?? company.hist
  const nHist = hist.length
  const [metric, setMetric] = useState(METRICS[0][0])
  const proj = projection?.scenarios[active].length === n ? projection.scenarios[active] : null
  const projYears = proj ? projection!.years : []
  const m = METRICS.find(x => x[0] === metric)!
  const others = proj ? (['bear', 'base', 'bull'] as Scenario[]).filter(s => s !== active).map(s => ({
    name: s, label: NAMES[s].toLowerCase(), values: [...hist.map(() => null), ...projection!.scenarios[s].map(m[2])],
  })) : []
  const rows = proj ? [...hist, ...proj] : hist
  return (
    <section className="f-tier" aria-labelledby="proj-h" id="projection">
      <h2 id="proj-h">What the forecast produces</h2>
      <p className="why">{histYears[0]}–{histYears[nHist - 1]} reported in ink; {projYears.length ? `${projYears[0]}–${projYears[n - 1]}` : 'the forecast'} in blue ({NAMES[active].toLowerCase()} case).</p>
      {proj && <Readout hist={hist} proj={proj} histYear={histYears[nHist - 1]} projYear={projYears[n - 1]} n={n}
        ttm={parsed.ttm && Date.parse(parsed.ttm.end) > Date.parse(company.dates[nHist - 1]) ? parsed.ttm : null} />}
      {proj && <Compare all={projection!.scenarios} active={active} projYear={projYears[n - 1]} />}
      {borrowed >= 0.5 && <p className="guard">Cash would run out, so the model borrows <b>Rs {money(borrowed)} cr</b> over {n} years
        to cover it. Lower capital spending or payout, or set the planned borrowing change yourself.</p>}
      <div className="chart-card">
        <div className="tabs" role="tablist" aria-label="Chart">
          {METRICS.map(([k, label]) => (
            <button key={k} id={`chart-tab-${k}`} type="button" role="tab" className="tab" aria-selected={metric === k}
              aria-controls="chart-panel" tabIndex={metric === k ? 0 : -1} onClick={() => setMetric(k)}
              onKeyDown={e => groupKeys(e, METRICS.map(x => x[0]), metric, setMetric)}>{label}</button>
          ))}
        </div>
        <div id="chart-panel" role="tabpanel" aria-labelledby={`chart-tab-${metric}`}>
          <Chart title={m[1]} years={[...histYears, ...projYears]} values={rows.map(m[2])} nHist={nHist} others={others} />
        </div>
      </div>
    </section>
  )
}

function Readout({ hist, proj, histYear, projYear, n, ttm }: {
  hist: Row[]; proj: Row[]; histYear: string; projYear: string; n: number; ttm: Ttm | null
}) {
  const last = hist[hist.length - 1], end = proj[proj.length - 1]
  const r0 = last.revenue ?? 0, r1 = end.revenue ?? 0
  const cagr = r0 > 0 && r1 > 0 ? (r1 / r0) ** (1 / n) - 1 : null
  const margin = (r: Row) => (r.revenue ? (r.pat ?? 0) / r.revenue : null)
  const fcf = proj.reduce((s, r) => s + (r.fcf ?? 0), 0)
  const netCash = (end.cash ?? 0) + (end.investments ?? 0) - (end.borrowings ?? 0) - (end.lease ?? 0)
  const P = ({ children }: { children: ReactNode }) => <span className="num ours">{children}</span>
  const ttmGrowth = growth(ttm?.values.sales, r0)
  return (
    <p className="readout">
      Sales go from <span className="num">Rs {money(r0)} cr</span> in {histYear} to <P>Rs {money(r1)} cr</P> in {projYear}
      {cagr != null && <>, <P>{fmt(cagr, 'pct')}</P> a year</>}. Net margin moves from <span className="num">{fmt(margin(last), 'pct')}</span> to{' '}
      <P>{fmt(margin(end), 'pct')}</P>. Over {n} years the business {fcf >= 0 ? 'generates' : 'burns'}{' '}
      <P>Rs {money(Math.abs(fcf))} cr</P> of free cash and ends with <P>Rs {money(Math.abs(netCash))} cr</P> net {netCash >= 0 ? 'cash' : 'debt'}.
      {ttmGrowth != null && <> In the twelve months to {month(ttm!.end)}, sales were <span className="num">Rs {money(ttm!.values.sales)} cr</span>,{' '}
        {fmt(Math.abs(ttmGrowth), 'pct')} {ttmGrowth >= 0 ? 'above' : 'below'} {histYear}.</>}
    </p>
  )
}

function Compare({ all, active, projYear }: { all: Projection['scenarios']; active: Scenario; projYear: string }) {
  const order: Scenario[] = ['bear', 'base', 'bull']
  const list = (k: string) => order.map((s, i) => {
    const v = money(all[s][all[s].length - 1][k])
    return <span key={s}>{i > 0 && ' · '}{NAMES[s].toLowerCase()} {s === active ? <b className="num ours">{v}</b> : <span className="num">{v}</span>}</span>
  })
  return <p className="compare">In {projYear}, sales: {list('revenue')} cr. Net profit: {list('pat')} cr.</p>
}

/** "Did a business leave the group?": revenue (and EBITDA) of a business sold, demerged or moved to a joint venture,
 * taken out of the last reported year before growth applies. Yours needs a reason; an approved annual-report note
 * (Documents) does the same with its quote. Rules check the size; the Excel export shows both as inputs. */
function MovedOutCard({ doc, setDoc, year, revenue, used }: {
  doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; year: string; revenue: number; used: Sources['moved_out'] | null
}) {
  const href = useHref()
  const mine = doc.notes['adj:moved_out'] as MovedOut | undefined
  const [rev, setRev] = useState(mine?.revenue != null ? String(mine.revenue) : '')
  const [ebitda, setEbitda] = useState(mine?.ebitda != null ? String(mine.ebitda) : '')
  const [reason, setReason] = useState(mine?.reason ?? '')
  const [msg, setMsg] = useState('')
  const [opened] = useState(!!used) // open while in use when the page opens; your own toggling stays yours
  const r = Number(rev.replace(/,/g, '')), e = ebitda.trim() === '' ? null : Number(ebitda.replace(/,/g, ''))
  const bad = !rev.trim() ? 'Type the revenue that left.' : !(r > 0 && r < revenue) ? `Revenue must be above 0 and below ${year}’s Rs ${money(revenue)} cr.`
    : e != null && !(Number.isFinite(e) && Math.abs(e) <= r) ? 'Operating profit can’t be larger than that revenue.'
    : !reason.trim() ? 'Say what happened (e.g. “Unit X moved into a JV from April”).' : null
  const save = () => {
    if (bad) return setMsg(bad)
    setDoc(d => ({ ...d, notes: { ...d.notes, 'adj:moved_out': { year, revenue: r, ebitda: e, reason: reason.trim() } satisfies MovedOut } }))
    setMsg(`Saved: the forecast now grows from ${year} sales less Rs ${money(r)} cr.`)
  }
  const remove = () => {
    setDoc(d => { const { ['adj:moved_out']: _, ...notes } = d.notes; return { ...d, notes } })
    setRev(''); setEbitda(''); setReason('')
    setMsg('Removed: the forecast grows from the full reported sales again.')
  }
  return (
    <details className="sub-fold moved" open={opened || undefined}>
      <summary>Did a business leave the group?{used && <> <Src kind="you">In use</Src></>}</summary>
      <p className="small">If a business was sold, demerged or moved into a joint venture, take its sales out of {year}, the year
        the forecast grows from. Otherwise growth is applied to sales the company no longer has.</p>
      {used && <p className="small"><b>In use:</b> Rs {money(used.revenue_out)} cr of sales and Rs {money(used.ebitda_out)} cr of
        operating profit left out of {used.year} ({used.reason}).{used.from === 'annual report' && <> From an approved note: <a href={href('documents', 'reading')}>see its quote</a>.</>}</p>}
      <div className="moved-f">
        <label>Sales that left, Rs crore<input inputMode="decimal" value={rev} onChange={x => setRev(x.target.value)} /></label>
        <label>Its operating profit (EBITDA), Rs crore <span className="dim">(optional: blank = at {year}’s margin)</span>
          <input inputMode="decimal" value={ebitda} onChange={x => setEbitda(x.target.value)} /></label>
        <label>What happened<input value={reason} maxLength={200} onChange={x => setReason(x.target.value)}
          placeholder="e.g. Steel unit moved into a JV from April" /></label>
      </div>
      <div className="next-act">
        <button type="button" className="btn" onClick={save}>{mine ? 'Update' : 'Take it out of the base'}</button>
        {mine && <button type="button" className="link" onClick={remove}>Remove</button>}
      </div>
      <p className="small dim" role="status">{msg || 'An AI reading of the annual report can propose this with a quote: Documents and sources → “Business moved out”.'}</p>
    </details>
  )
}
