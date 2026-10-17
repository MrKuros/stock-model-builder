import { useEffect, useMemo, useRef, useState } from 'react'
import Chart from './Chart'
import DriverStrip from './DriverStrip'
import { growth, month } from './Statements'
import DraftPanel, { failing, latest, path, useDraft } from './Draft'
import { Checks } from './Sources'
import { PageHead, Toc } from './Shell'
import { useHref } from './route'
import {
  DOC_KINDS, defaultPaths, fmt, flat, groupKeys, isAnnual, money, seed, SCENARIOS, SHIFT, shortYear, type Proposal,
  type Kind, type ModelDoc, type Parsed, type Paths, type Projection, type Row, type Scenario, type Ttm,
} from './lib'

const GROUPS: [string, string[]][] = [
  ['Growth and margins', ['growth', 'ebitda_margin', 'oi_pct']],
  ['Investment', ['capex_pct', 'dep_pct']],
  ['Working capital', ['dso', 'cogs_pct', 'dio', 'dpo', 'oca_pct', 'ol_pct']],
  ['Financing and tax', ['debt_change', 'int_rate', 'tax_rate', 'mi_pct', 'payout']],
]
const HINTS: Record<string, string> = {
  growth: 'Change in sales vs the year before',
  ebitda_margin: 'Operating profit before depreciation, share of sales',
  oi_pct: 'Treasury and non-operating income, share of sales',
  capex_pct: 'Spend on new fixed assets, share of sales',
  dep_pct: 'Share of last year’s net block written off',
  dso: 'Days of sales waiting to be collected',
  cogs_pct: 'Materials, purchases and inventory change, share of sales. Sets the base for inventory and payable days',
  dio: 'Days of sales held as stock',
  dpo: 'Days of sales owed to suppliers',
  oca_pct: 'Advances, deposits and other current assets',
  ol_pct: 'Payables, provisions and other liabilities',
  debt_change: 'Net new debt you plan each year. Shortfalls are borrowed automatically',
  int_rate: 'Interest as share of last year’s borrowings and lease liabilities',
  tax_rate: 'Tax as share of profit before tax',
  mi_pct: 'Associates’ profit added, minority holders’ share taken out',
  payout: 'Share of net profit paid as dividend',
}
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
// defaults an attached annual filing can move (payables, cash-flow capex); inventory days and COGS come from Export
export const UPGRADED = ['dpo', 'ol_pct', 'capex_pct']
/** A default the filings moved, offered to all three scenarios in one click: base's value now, the new default. */
export interface Upgrade { key: string; label: string; kind: Kind; from: number; to: number }
const METRICS: [string, string, (r: Row) => number | null][] = [
  ['revenue', 'Revenue', r => r.revenue],
  ['ebitda', 'EBITDA', r => r.ebitda],
  ['pat', 'Net profit', r => r.pat],
  ['fcf', 'Free cash flow', r => r.fcf],
  ['net_cash', 'Net cash', r => (r.cash ?? 0) + (r.investments ?? 0) - (r.borrowings ?? 0) - (r.lease ?? 0)],
]

interface Props {
  parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; projection: Projection | null
  anchor: string; upgrades: Upgrade[]; onApply: () => void
}

/** Forecast: every input with where it came from, the selected one's evidence and editor, then the projection. */
export default function ModelView({ parsed, doc, setDoc, projection, anchor, upgrades, onApply }: Props) {
  const href = useHref()
  const { company, years: histYears, ratios, defaults, drivers } = parsed
  const { n, active, scenarios } = doc
  const a = scenarios[active]
  const setA = (f: (p: Paths) => Paths) =>
    setDoc(d => ({ ...d, scenarios: { ...d.scenarios, [d.active]: f(d.scenarios[d.active]) } }))
  const seeded = useMemo(() => seed(defaultPaths(defaults, parsed.default_ends)), [defaults, parsed.default_ends])
  const [metric, setMetric] = useState(METRICS[0][0])
  const byKey = Object.fromEntries(drivers.map(d => [d[0], d]))
  const [sel, setSel] = useState(() => (byKey[anchor] ? anchor : 'growth'))
  const panel = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (byKey[anchor]) setSel(anchor) }, [anchor]) // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (k: string) => {
    setSel(k)
    if (window.matchMedia('(max-width: 980px)').matches) // the panel sits below the table: take the reader there
      window.setTimeout(() => { panel.current?.scrollIntoView({ block: 'start' }); panel.current?.focus() }, 0)
  }

  const hist = parsed.hist ?? company.hist
  const nHist = hist.length
  const sources = parsed.sources
  const proj = projection?.scenarios[active].length === n ? projection.scenarios[active] : null
  const projYears = proj ? projection!.years : []
  const years = [...histYears, ...projYears]
  const rows = proj ? [...hist, ...proj] : hist
  const implied = proj ? projection!.valuation.scenarios[active].implied_growth ?? null : null
  const onCogs = sources?.basis === 'cogs'
  const nonZero = (k: string) => !!a[k] && (a[k].start !== 0 || (a[k].end ?? 0) !== 0)
  const shown = (k: string) => !!byKey[k] && (!sources || (k === 'cogs_pct' ? onCogs
    : k === 'dpo' ? sources.used.payables.length > 0 || nonZero(k) : true))
  const hintFor = (k: string) => (onCogs && k === 'dio' ? 'Days of cost of goods sold held as stock'
    : onCogs && k === 'dpo' ? 'Days of cost of goods sold owed to suppliers'
    : k === 'ol_pct' && sources?.used.payables.length ? 'Provisions, advances and other liabilities; trade payables are separate'
    : HINTS[k] ?? '')
  const balanced = proj?.every(r => Math.abs(r.chk_bs ?? 0) < 0.5 && Math.abs(r.chk_cash ?? 0) < 0.5)
  const offIdx = proj ? proj.findIndex(r => Math.abs(r.chk_bs ?? 0) >= 0.5 || Math.abs(r.chk_cash ?? 0) >= 0.5) : -1
  const off = offIdx >= 0 ? Math.max(Math.abs(proj![offIdx].chk_bs ?? 0), Math.abs(proj![offIdx].chk_cash ?? 0)) : 0
  const roundingOnly = offIdx === 0 && off <= 2 && proj!.slice(1).every(r => Math.abs(r.chk_bs ?? 0) < 0.5 && Math.abs(r.chk_cash ?? 0) < 0.5)
  const borrowed = proj ? proj.reduce((s, r) => s + (r.revolver ?? 0), 0) : 0
  const m = METRICS.find(x => x[0] === metric)!
  const others = proj ? SCENARIOS.filter(s => s !== active).map(s => ({
    name: s, values: [...hist.map(() => null), ...projection!.scenarios[s].map(m[2])],
  })) : []
  const copyBase = () => {
    const next = seed(scenarios.base)
    const edited = (['bull', 'bear'] as const).some(s => JSON.stringify(scenarios[s]) !== JSON.stringify(next[s]))
    if (edited && !window.confirm('Replace your bull and bear assumptions with base ± 3 pp growth and ± 1.5 pp EBITDA margin?')) return
    // bull and bear now come from base, so they take base's sources too
    setDoc(d => ({ ...d, scenarios: next, assumption_sources: { ...d.assumption_sources, bull: { ...d.assumption_sources.base }, bear: { ...d.assumption_sources.base } } }))
  }
  const draft = useDraft(doc, setDoc)
  const srcOf = (k: string) => doc.assumption_sources[active]?.[k]
  const propOf = (id: string | undefined) => (id && id !== 'manual' && id !== 'history' ? doc.proposals.find(p => p.id === id) : undefined)
  const docOf = (p: Proposal) => {
    const r = doc.reports.find(x => x.id === p.report)
    return r ? `${r.year} ${DOC_KINDS[r.kind ?? 'annual'].toLowerCase()}` : p.source.file ?? 'a document'
  }
  /** The source chip: an accepted AI proposal, the rule default from history, your edit, or (before 4.2) by value. */
  const chipOf = (k: string): [cls: string, tag: string, text: string] => {
    const s = srcOf(k), p = propOf(s), kind = kindOf(k)
    if (p) return ['ai', 'AI', `${docOf(p)}, p.${p.source.page}`]
    if (s === 'manual') return ['you', 'You', `default ${fmt(seeded[active][k]?.start, kind)}`]
    if (s === 'history') return ['rule', 'History', 'rule default from the reported years']
    return isYou(k) ? ['you', 'You', `default ${fmt(seeded[active][k]?.start, kind)}`] : ['rule', 'Rule', sources?.drivers[k] ?? ruleOf(k)]
  }
  const recent = histYears.slice(-3)
  const flagOf = (k: string) => parsed.oneoffs.filter(o => o.metric === k && recent.includes(o.year))
  const checkOf = (k: string) => (parsed.rule_checks ?? []).find(c => c.id === k && (c.status === 'red' || c.status === 'amber'))
  const valueOf = (k: string) => a[k] ?? flat(seeded[active][k].start)
  const isYou = (k: string) => {
    const p = valueOf(k), d = seeded[active][k]
    return Math.abs(p.start - (d?.start ?? 0)) > 1e-9 || (p.end == null) !== (d?.end == null) || (p.end != null && Math.abs(p.end - d!.end!) > 1e-9)
  }
  const range = (k: string) => { const xs = ratios.map(r => r[k]).filter((x): x is number => x != null && Number.isFinite(x)); return xs.length ? [Math.min(...xs), Math.max(...xs)] : null }
  const used = histYears.filter(y => !doc.excluded_years.includes(y)).slice(-3) // mirrors default_assumptions(years=3)
  const kindOf = (k: string) => byKey[k][2] as Kind

  const selKey = shown(sel) ? sel : 'growth'
  const flags = flagOf(selKey), lit = checkOf(selKey)
  // the selected input's AI proposal: one waiting for you in the latest draft, else the one its value came from
  const aiCard = latest(doc).find(p => p.field === selKey && p.status === 'proposed' && !p.from_history) ?? propOf(srcOf(selKey))

  const waiting = latest(doc).some(p => p.status === 'proposed')
  const nDocs = 1 + (doc.filings.length ? 1 : 0) + (doc.reports.some(isAnnual) ? 1 : 0) + (doc.reports.some(r => !isAnnual(r)) ? 1 : 0)
  const resetActive = () => setDoc(d => ({ ...d, scenarios: { ...d.scenarios, [active]: seeded[active] },
    assumption_sources: { ...d.assumption_sources, [active]: {} } }))

  return (
    <>
      <PageHead label={<>Forecast · <b>{active} case</b> · {projYears.length ? `${projYears[0]}–${projYears[n - 1]}` : `${n} years`} · Rs crore</>}
        title="Change the forecast"
        purpose={<>Pick an input in the table to see its history and the rule behind it, then drag the blue line or type a value.
          Edits change the <b>{active}</b> case (bear is cautious, base central, bull hopeful); every page recalculates. Recalculating never calls AI.</>}
        next={<a className="btn" href="#draft">Draft from documents</a>} />
      <Toc page="forecast" />
      <p className="status-line" aria-live="polite">
        {balanced && <span className="ok">Balance sheet balances in every projected year</span>}
        {offIdx >= 0 && (roundingOnly
          ? <span className="ok">Balance sheet balances; {projYears[0]} cash is off by Rs {money(off)} cr from rounding in the reported figures</span>
          : <span className="bad" role="alert">Balance check fails in {projYears[offIdx]} by Rs {money(off)} cr</span>)}
      </p>

      {upgrades.length > 0 && (
        <div className="src-upgrade" role="status">
          <p className="small">The filings and approved notes moved these defaults:{' '}
            {upgrades.map((u, i) => <span key={u.key}>{i > 0 && '; '}{u.label.toLowerCase()} now{' '}
              <span className="pencil-num">{fmt(u.to, u.kind)}</span> (base uses {fmt(u.from, u.kind)})</span>)}.
            Your assumptions haven’t changed.</p>
          <button type="button" onClick={onApply}>Use the new defaults in base, bull and bear</button>
        </div>
      )}

      <details className="fold" id="draft" open={waiting || undefined}>
        <summary><span><b>Let the documents set the inputs</b> · AI reads your annual reports and call transcripts and
          proposes every input with a quote; rules check it; you accept.</span>{waiting && <span className="tag prop">Waiting for you</span>}</summary>
        <DraftPanel parsed={parsed} doc={doc} d={draft} />
      </details>

      <div className="mgrid" id="inputs">
        <section aria-labelledby="inputs-h">
          <div className="inputs-head">
            <h2 id="inputs-h" className="m-h2">Inputs · {active} case</h2>
            <p className="small">Bull and bear start from base with revenue growth ± 3 pp and EBITDA margin ± 1.5 pp.{' '}
              <button type="button" className="link" onClick={copyBase}>Copy base to bull and bear</button>{' · '}
              <button type="button" className="link" onClick={resetActive}>Reset {active} to the rule defaults</button></p>
          </div>
          <div className="atab" role="list" aria-label={`Assumptions, ${active} case. Choose one to see its evidence and edit it.`}>
            <div className="arow head" aria-hidden="true"><span>Input</span><span>{shortYear(histYears[0])}–{shortYear(histYears[nHist - 1]).slice(2)} → used</span><span>Used</span><span>{histYears[nHist - 1]} · range</span><span>Source</span></div>
            {GROUPS.map(([group, keys]) => (
              <div key={group} role="presentation">
                <div className="agroup" aria-hidden="true">{group}</div>
                {keys.filter(shown).map(k => {
                  const kind = kindOf(k), p = valueOf(k), r = range(k), lastV = ratios[nHist - 1]?.[k]
                  const f = flagOf(k)[0], c = checkOf(k), [cls, tag, text] = chipOf(k)
                  const usedText = p.end != null ? `${fmt(p.start, kind)} → ${fmt(p.end, kind)}` : fmt(p.start, kind)
                  return (
                    <div role="listitem" key={k} id={`a-${k}`}>
                      <button type="button" className={`arow${selKey === k ? ' sel' : ''}`} aria-pressed={selKey === k}
                        aria-label={`${byKey[k][1]}: ${usedText}${f || c ? ', flagged' : ''}. Source: ${tag}, ${text}.`}
                        onClick={() => pick(k)}>
                        <span className="an">{byKey[k][1].replace(/ \(history incl\. exceptionals\)/, '')}
                          {(f || c) && <em className="redpen">{f ? `${shortYear(f.year)} unusual` : `${shortYear(histYears[nHist - 1])} up`}</em>}</span>
                        <Spark hist={ratios.map(r => r[k])} used={p} />
                        <span className="num ours">{usedText}</span>
                        <span className="num dim">{fmt(lastV, kind)}{r && <> · {fmt(r[0], kind)}–{fmt(r[1], kind)}</>}</span>
                        <span className="asrc"><span className={`tag ${cls}`}>{tag}</span>
                          <span className="small">{text}</span></span>
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </section>

        <aside className="panel" aria-labelledby="panel-h">
          <p className="label">The selected input</p>
          <h2 id="panel-h" ref={panel} tabIndex={-1}>{byKey[selKey][1].replace(/ \(history incl\. exceptionals\)/, '')}{' '}
            <span className="num ours">{fmt(valueOf(selKey).start, kindOf(selKey))}</span></h2>
          <div className="card">
            <DriverStrip key={`${company.name}-${selKey}`} id={selKey} label={`Edit ${byKey[selKey][1]}`} hint={hintFor(selKey)}
              source={sources?.drivers[selKey]} kind={kindOf(selKey)} history={ratios.map(r => r[selKey])}
              value={valueOf(selKey)} base={seeded[active][selKey].start}
              baseLabel={selKey === 'debt_change' ? 'no new debt' : `default ${fmt(seeded[active][selKey].start, kindOf(selKey))}`}
              onChange={v => setA(prev => ({ ...prev, [selKey]: v }))} ghost={selKey === 'growth' ? implied : null} />
          </div>
          {aiCard && <AiCard p={aiCard} kind={kindOf(selKey)} current={valueOf(selKey)} doc={docOf(aiCard)} active={active}
            inUse={propOf(srcOf(selKey))?.id === aiCard.id} busy={!!draft.busy}
            onApprove={() => draft.accept([aiCard])} onKeep={() => draft.reject(aiCard)} />}
          <div className="card">
            <div className="card-h"><span>How the rule got it</span><span className="tag rule">Rule</span></div>
            <p className="small">{sources?.drivers[selKey] ?? ruleOf(selKey)}.</p>
            {selKey !== 'debt_change' && <p className="arith num">
              {(selKey === 'growth' ? histYears.slice(-4) : used).map(y => {
                const i = histYears.indexOf(y)
                return <span key={y}>{y} {selKey === 'growth' ? money(hist[i].revenue) : fmt(ratios[i][selKey], kindOf(selKey))}</span>
              })}
              <span className="ours">= {fmt(seeded[active][selKey].start, kindOf(selKey))}{active !== 'base' && SHIFT[selKey] ? ` (${active}: base ± ${+(SHIFT[selKey] * 100).toFixed(2)} pp)` : ''}{seeded[active][selKey].end != null ? `, fading to ${fmt(seeded[active][selKey].end!, kindOf(selKey))} (a fast grower)` : ''}</span>
            </p>}
            <p className="small dim">{selKey === 'growth' ? 'Revenue, Rs crore' : 'Each year as reported'}, from the Export export{doc.excluded_years.length ? `; left out: ${doc.excluded_years.join(', ')}` : ''}.</p>
          </div>
          {(flags.length > 0 || lit) && <div className="card flag">
            <div className="card-h"><span>Flag</span><span className="tag flag">{lit?.status === 'red' || flags.some(f => f.year === histYears[nHist - 1]) ? 'High' : 'Watch'}</span></div>
            {flags.map(f => <p key={f.year} className="small">{f.note}. The default may carry it; in Checks you can leave the year out or explain it.</p>)}
            {lit && <p className="small">{lit.fact}. {lit.rule}.</p>}
            <a className="go small" href={href('checks', flags.length ? 'unusual' : lit!.id)}>See it in Checks</a>
          </div>}
          <div className="card doclist">
            <p className="small"><b>{nDocs} of 4 documents</b> attached: the Export export{doc.filings.length ? ', XBRL filings' : ''}{doc.reports.length ? `, ${doc.reports.map(r => `${r.year} ${DOC_KINDS[r.kind ?? 'annual'].toLowerCase()}`).join(', ')}` : ''}.{' '}
              <a className="go" href={href('checks', 'documents')}>Add documents</a></p>
          </div>
        </aside>
      </div>

      <section className="m-sec" aria-labelledby="proj-h" id="projection">
        <h2 id="proj-h" className="m-h2">Projection <span className="dim">{histYears[0]}–{histYears[nHist - 1]} reported · {projYears[0] ?? ''}{projYears.length ? `–${projYears[n - 1]}` : ''} {active} case</span></h2>
        {proj && <Readout hist={hist} proj={proj} histYear={histYears[nHist - 1]} projYear={projYears[n - 1]} n={n}
          ttm={parsed.ttm && Date.parse(parsed.ttm.end) > Date.parse(company.dates[nHist - 1]) ? parsed.ttm : null} />}
        {proj && <Compare all={projection!.scenarios} active={active} projYear={projYears[n - 1]} />}
        {borrowed >= 0.5 && <p className="banner">Cash would run out, so the model borrows <b>Rs {money(borrowed)} cr</b> over {n} years
          to cover it. Lower capex or payout, or set <b>Planned borrowing change per year</b> yourself.</p>}
        <div className="chart-card">
          <div className="tabs" role="tablist" aria-label="Chart">
            {METRICS.map(([k, label]) => (
              <button key={k} id={`chart-tab-${k}`} type="button" role="tab" className="tab" aria-selected={metric === k}
                aria-controls="chart-panel" tabIndex={metric === k ? 0 : -1} onClick={() => setMetric(k)}
                onKeyDown={e => groupKeys(e, METRICS.map(x => x[0]), metric, setMetric)}>{label}</button>
            ))}
          </div>
          <div id="chart-panel" role="tabpanel" aria-labelledby={`chart-tab-${metric}`}>
            <Chart title={m[1]} years={years} values={rows.map(m[2])} nHist={nHist} others={others} />
          </div>
        </div>
        <p className="small">Every line year by year: <a href={href('statements')}>the full statements</a>. What it is worth: <a href={href('valuation')}>Valuation</a>.</p>
      </section>
    </>
  )
}

/** History as dots (ink), the value used as a blue stroke to the right of the last year. */
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

function Readout({ hist, proj, histYear, projYear, n, ttm }: {
  hist: Row[]; proj: Row[]; histYear: string; projYear: string; n: number; ttm: Ttm | null
}) {
  const last = hist[hist.length - 1], end = proj[proj.length - 1]
  const r0 = last.revenue ?? 0, r1 = end.revenue ?? 0
  const cagr = r0 > 0 && r1 > 0 ? (r1 / r0) ** (1 / n) - 1 : null
  const margin = (r: Row) => (r.revenue ? (r.pat ?? 0) / r.revenue : null)
  const fcf = proj.reduce((s, r) => s + (r.fcf ?? 0), 0)
  const netCash = (end.cash ?? 0) + (end.investments ?? 0) - (end.borrowings ?? 0) - (end.lease ?? 0)
  const P = ({ children }: { children: React.ReactNode }) => <span className="num ours">{children}</span>
  const ttmGrowth = growth(ttm?.values.sales, r0)
  return (
    <p className="readout">
      Revenue goes from <span className="num">Rs {money(r0)} cr</span> in {histYear} to <P>Rs {money(r1)} cr</P> in {projYear}
      {cagr != null && <>, <P>{fmt(cagr, 'pct')}</P> a year</>}. Net margin moves from <span className="num">{fmt(margin(last), 'pct')}</span> to{' '}
      <P>{fmt(margin(end), 'pct')}</P>. Over {n} years the business {fcf >= 0 ? 'generates' : 'burns'}{' '}
      <P>Rs {money(Math.abs(fcf))} cr</P> of free cash and ends with <P>Rs {money(Math.abs(netCash))} cr</P> net {netCash >= 0 ? 'cash' : 'debt'}.
      {ttmGrowth != null && <> In the twelve months to {month(ttm!.end)}, revenue was <span className="num">Rs {money(ttm!.values.sales)} cr</span>,{' '}
        {fmt(Math.abs(ttmGrowth), 'pct')} {ttmGrowth >= 0 ? 'above' : 'below'} {histYear}.</>}
    </p>
  )
}

function Compare({ all, active, projYear }: { all: Projection['scenarios']; active: Scenario; projYear: string }) {
  const order: Scenario[] = ['bear', 'base', 'bull']
  const list = (k: string) => order.map((s, i) => {
    const v = money(all[s][all[s].length - 1][k])
    return <span key={s}>{i > 0 && ' · '}{s} {s === active ? <b className="num ours">{v}</b> : <span className="num">{v}</span>}</span>
  })
  return <p className="compare">In {projYear}, revenue: {list('revenue')} cr. Net profit: {list('pat')} cr.</p>
}

/** The desk's proposal card: the AI's value for the selected input, its reasoning and quote, the rule checks, and
 * approve / keep. Approving saves the values as ordinary inputs; nothing recalculates through the AI. */
function AiCard({ p, kind, current, doc, active, inUse, busy, onApprove, onKeep }: {
  p: Proposal; kind: Kind; current: { start: number; end: number | null }; doc: string; active: Scenario; inUse: boolean
  busy: boolean; onApprove: () => void; onKeep: () => void
}) {
  const v = (p.value as Record<Scenario, { start: number; end: number | null }>)
  const bad = failing(p)
  return (
    <div className={`card ai-card${bad ? ' flag' : ''}`}>
      <div className="card-h"><span>{p.status === 'proposed' ? 'AI proposal' : 'From an accepted AI proposal'}</span>
        <span className="tag ai">AI · cited</span></div>
      <p className="ai-val"><span className="num ours">{path(v[active], kind)}</span> <span className="small dim">{active} ·
        bear {path(v.bear, kind)} · bull {path(v.bull, kind)}</span></p>
      <p className="serif">{p.reasoning}</p>
      {p.source.quote && <blockquote className="prop-quote serif">“{p.source.quote}” <span className="small dim">{doc}, p.{p.source.page}</span></blockquote>}
      {p.outside && <p className="small">Outside its history because: {p.outside}</p>}
      <Checks checks={p.checks} />
      {p.status === 'proposed' && <>
        <div className="prop-actions">
          <button type="button" onClick={onApprove} disabled={bad} aria-disabled={busy}>Approve {path(v[active], kind)}</button>
          <button type="button" onClick={onKeep}>Keep {path(current, kind)}</button>
        </div>
        <p className="small dim">Approving saves bear, base and bull as ordinary inputs with this quote. Nothing recalculates through the AI.</p>
      </>}
      {p.status !== 'proposed' && !inUse && <p className="small dim">Changed since; the input no longer uses this proposal.</p>}
    </div>
  )
}
