import { useState } from 'react'
import { Checks } from './Sources'
import {
  api, DOC_KINDS, fmt, isAnnual, postJson, SCENARIOS, type Drafted, type Kind, type ModelDoc, type Parsed, type Path,
  type Proposal, type Scenario,
} from './lib'

const ORDER: Scenario[] = ['bear', 'base', 'bull']
const NAMES: Record<Scenario, string> = { base: 'Base', bull: 'Bull', bear: 'Bear' }
type SetDoc = (f: (d: ModelDoc) => ModelDoc) => void
interface Msg { text: string; bad?: boolean }

export const failing = (p: Proposal) => p.checks.some(c => c.pass === false)
export const path = (p: Path | undefined, kind: Kind) => (p == null ? '–' : p.end != null && Math.abs(p.end - p.start) > 1e-12
  ? `${fmt(p.start, kind)} → ${fmt(p.end, kind)}` : fmt(p.start, kind))
const docName = (doc: ModelDoc, p: Proposal) => {
  const r = doc.reports.find(x => x.id === p.report)
  return r ? `${r.year} ${isAnnual(r) ? 'annual report' : DOC_KINDS[r.kind ?? 'annual'].toLowerCase()}` : p.source.file ?? 'a document'
}
/** The latest draft: its proposals, one per driver. */
export const latest = (doc: ModelDoc) => {
  const ps = doc.proposals.filter(p => p.kind === 'assumption')
  const round = ps.reduce<string | undefined>((m, p) => (p.round && (!m || p.round > m) ? p.round : m), undefined)
  return round ? ps.filter(p => p.round === round) : []
}

/** Drafting and deciding: the draft call, and accepting (rules re-check on the server, no LLM call), rejecting and
 * editing a proposal. Accepted values become ordinary assumptions with their source in doc.assumption_sources. */
export function useDraft(doc: ModelDoc, setDoc: SetDoc) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Msg | null>(null)
  const ctx = { company: doc.company, excluded_years: doc.excluded_years, filings: doc.filings, notes: doc.notes, reports: doc.reports, n: doc.n }

  const draft = async () => {
    if (busy) return
    setBusy(doc.reports.length ? 'Picking the pages and asking the model… (about a minute)' : 'Taking the rule defaults…')
    setMsg(null)
    try {
      const r = await api<{ proposals: Proposal[]; message: string }>('/api/assumptions/draft', postJson(ctx))
      const round = new Date().toISOString()
      setDoc(d => {
        // earlier drafts go, except proposals an input still points at (kept as its record)
        const used = new Set(Object.values(d.assumption_sources).flatMap(x => Object.values(x ?? {})))
        const fresh = new Map(r.proposals.map(p => [p.id, { ...p, round }]))
        const keep = d.proposals.filter(p => p.kind !== 'assumption' || used.has(p.id))
          .map(p => (fresh.has(p.id) ? { ...p, round } : p))
        return { ...d, proposals: [...keep, ...[...fresh.values()].filter(p => !keep.some(x => x.id === p.id))] }
      })
      setMsg({ text: r.message })
    } catch (e) { setMsg({ text: (e as Error).message, bad: true }) } finally { setBusy(null) }
  }

  const accept = async (ps: Proposal[]) => {
    if (busy || !ps.length) return
    setBusy('Checking again by rules…')
    setMsg(null)
    try {
      const r = await api<{ proposals: Proposal[] }>('/api/assumptions/check', postJson({ ...ctx, scenarios: doc.scenarios, proposals: ps }))
      const ok = r.proposals.filter(p => !failing(p))
      const by = new Map(r.proposals.map(p => [p.id, p]))
      setDoc(d => {
        const scenarios = { ...d.scenarios }, src = { ...d.assumption_sources }
        for (const s of SCENARIOS) {
          scenarios[s] = { ...scenarios[s] }
          src[s] = { ...src[s] }
          for (const p of ok) { scenarios[s][p.field] = (p.value as Drafted)[s]; src[s]![p.field] = p.from_history ? 'history' : p.id }
        }
        return { ...d, scenarios, assumption_sources: src, proposals: d.proposals.map(x => {
          const y = by.get(x.id)
          return y ? { ...x, value: y.value, checks: y.checks, status: failing(y) ? 'rejected' as const : 'approved' as const } : x
        }) }
      })
      const bad = r.proposals.filter(failing)
      setMsg(bad.length ? { text: `The rules reject ${bad.map(p => p.field).join(', ')} now: ${bad[0].checks.find(c => c.pass === false)?.detail}`, bad: true }
        : { text: `Accepted ${ok.length} input${ok.length === 1 ? '' : 's'} for bear, base and bull. They are ordinary inputs now; recalculating never calls AI.` })
    } catch (e) { setMsg({ text: (e as Error).message, bad: true }) } finally { setBusy(null) }
  }

  const reject = (p: Proposal) => {
    setDoc(d => ({ ...d, proposals: d.proposals.map(x => (x.id === p.id ? { ...x, status: 'rejected' as const } : x)) }))
    setMsg({ text: `Kept the current ${p.field.replace(/_/g, ' ')}.` })
  }

  /** Your own starts (the proposal's ends kept): an ordinary edit, so the source becomes "manual". */
  const edit = (p: Proposal, starts: Record<Scenario, number>) => {
    setDoc(d => {
      const scenarios = { ...d.scenarios }, src = { ...d.assumption_sources }
      for (const s of SCENARIOS) {
        scenarios[s] = { ...scenarios[s], [p.field]: { start: starts[s], end: (p.value as Drafted)[s].end } }
        src[s] = { ...src[s], [p.field]: 'manual' }
      }
      return { ...d, scenarios, assumption_sources: src,
        proposals: d.proposals.map(x => (x.id === p.id && x.status === 'proposed' ? { ...x, status: 'rejected' as const } : x)) }
    })
    setMsg({ text: `Saved your values for ${p.field.replace(/_/g, ' ')}.` })
  }
  return { busy, msg, draft, accept, reject, edit }
}
export type Drafting = ReturnType<typeof useDraft>

/** The draft review: one row per driver, proposed against current for bear, base and bull, with the citation and the
 * rule checks; accept all that pass, or decide row by row. */
export default function DraftPanel({ parsed, doc, d }: { parsed: Parsed; doc: ModelDoc; d: Drafting }) {
  const rows = latest(doc)
  const kinds = Object.fromEntries(parsed.drivers.map(x => [x[0], x[2]])) as Record<string, Kind>
  const names = Object.fromEntries(parsed.drivers.map(x => [x[0], x[1].replace(/ \(history incl\. exceptionals\)/, '')]))
  const src = doc.assumption_sources
  const order = parsed.drivers.map(x => x[0])
  rows.sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field))
  const same = (p: Proposal) => SCENARIOS.every(s => JSON.stringify((p.value as Drafted)[s]) === JSON.stringify(doc.scenarios[s][p.field]))
  // accept-all never overwrites your own edits with a rule default, and skips rows that change nothing
  const passing = rows.filter(p => p.status === 'proposed' && !failing(p) && !same(p) && !(p.from_history && src.base?.[p.field] === 'manual'))
  const nDoc = rows.filter(p => !p.from_history).length, nBad = rows.filter(failing).length
  const docs = doc.reports
  return (
    <section className="draft m-sec" aria-labelledby="draft-h" id="a-draft">
      <div className="draft-head">
        <div>
          <p className="label">Draft assumptions · <b>AI reads, rules check, you accept</b></p>
          <h2 id="draft-h" className="m-h2">Let the documents set the inputs</h2>
          <p className="small-note">Rules pick the pages that talk about the years ahead; AI proposes every input for bear, base
            and bull with a quote; rules check the quote, the bounds, the company’s own history, the order of the cases
            and capex and payout against the cash. Inputs the documents don’t cover keep the rule default
            (“from history”). Accepted values are ordinary inputs: recalculating never calls AI.</p>
          <p className="small">{docs.length ? <>Reads: {docs.map(r => `${r.year} ${DOC_KINDS[r.kind ?? 'annual'].toLowerCase()}`).join(', ')}.</>
            : !d.msg && <>No documents attached, so a draft gives the rule defaults. Attach a call transcript, presentation or annual report in Evidence.</>}</p>
        </div>
        <button type="button" className="btn primary" onClick={d.draft} aria-disabled={!!d.busy}>
          {rows.length ? 'Draft again' : 'Draft assumptions'}</button>
      </div>
      <p className={`src-note ${d.msg?.bad ? 'is-bad' : ''}`} role="status" aria-busy={!!d.busy}>{d.busy ?? d.msg?.text}</p>
      {rows.length > 0 && <>
        <div className="draft-bar">
          <span className="small">{nDoc} read from documents{nBad ? ` (${nBad} rejected by rules)` : ''} · {rows.length - nDoc} from history</span>
          <button type="button" className="btn" onClick={() => d.accept(passing)} disabled={!passing.length} aria-disabled={!!d.busy}>
            Accept all passing ({passing.length})</button>
        </div>
        <div className="table-wrap draft-wrap" tabIndex={0} role="region" aria-label="Drafted inputs against current">
          <table className="draft-t" role="table">
            <caption className="sr">Each input: proposed bear, base and bull values against the current ones, the source, the rule checks and your decision</caption>
            <thead role="rowgroup"><tr role="row">{['Input', ...ORDER.map(s => NAMES[s]), 'Source', 'Checks', 'Decision'].map(h =>
              <th key={h} scope="col" role="columnheader">{h}</th>)}</tr></thead>
            <tbody role="rowgroup">{rows.map(p => <Row key={p.id} p={p} doc={doc} kind={kinds[p.field] ?? 'pct'} name={names[p.field] ?? p.field} d={d} />)}</tbody>
          </table>
        </div>
      </>}
    </section>
  )
}

/** A typed value in the driver's display unit (percent for pct) back to the engine's; null if it isn't a number. */
export const parseIn = (t: string, kind: Kind) => {
  const v = Number(t.trim().replace(/%$/, ''))
  return t.trim() && Number.isFinite(v) ? (kind === 'pct' ? v / 100 : v) : null
}
const shown = (v: number, kind: Kind) => (kind === 'pct' ? (v * 100).toFixed(1) : kind === 'days' ? v.toFixed(0) : v.toFixed(0))

function Row({ p, doc, kind, name, d }: { p: Proposal; doc: ModelDoc; kind: Kind; name: string; d: Drafting }) {
  const [edit, setEdit] = useState<Record<Scenario, string> | null>(null)
  const v = p.value as Drafted, bad = failing(p)
  const src = doc.assumption_sources.base?.[p.field]
  const inUse = src === (p.from_history ? 'history' : p.id) && p.status === 'approved'
  const state = p.status === 'proposed' ? null : src === 'manual' ? 'Edited by you' : inUse ? 'Accepted ✓'
    : p.status === 'approved' ? 'Accepted, since changed' : bad ? 'Rejected by rules; current kept' : 'Kept current'
  const firstBad = p.checks.find(c => c.pass === false)
  const same = (s: Scenario) => JSON.stringify(v[s]) === JSON.stringify(doc.scenarios[s][p.field])
  const noop = p.status === 'proposed' && ORDER.every(same) // nothing to decide: it is what the model uses already
  const save = () => {
    const out = Object.fromEntries(ORDER.map(s => [s, parseIn(edit![s], kind)])) as Record<Scenario, number | null>
    if (ORDER.some(s => out[s] == null)) return
    d.edit(p, out as Record<Scenario, number>)
    setEdit(null)
  }
  return (
    <tr role="row" className={`${bad ? 'is-bad' : ''}${p.status !== 'proposed' || noop ? ' is-done' : ''}`}>
      <th scope="row" role="rowheader">{name}</th>
      {ORDER.map(s => <td key={s} role="cell" className="dv" data-label={NAMES[s]}>{edit
        ? <label><span className="sr">{name}, {s} start{kind === 'pct' ? ', percent' : kind === 'days' ? ', days' : ', Rs crore'}</span>
          <input className="num" inputMode="decimal" value={edit[s]} onChange={e => setEdit({ ...edit, [s]: e.target.value })}
            aria-invalid={parseIn(edit[s], kind) == null} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(null) }} /></label>
        : <><span className={`num ${p.from_history ? '' : 'ours'}`}>{path(v[s], kind)}</span>
          <span className="now">{same(s) ? 'same as now' : <>now <span className="num">{path(doc.scenarios[s][p.field], kind)}</span></>}</span></>}</td>)}
      <td role="cell" className="ds">{p.from_history
        ? <><span className="tag rule">History</span><span className="small">rule default</span></>
        : <><span className="tag ai">AI · cited</span><span className="small">{docName(doc, p)}, p.{p.source.page}</span>
          <details><summary>Why</summary>
            <p className="serif">{p.reasoning}</p>
            {p.source.quote && <blockquote className="prop-quote serif">“{p.source.quote}”</blockquote>}
            {p.outside && <p className="small">Outside its history because: {p.outside}</p>}
          </details></>}</td>
      <td role="cell" className="dc">{p.from_history ? <span className="small dim">No AI number</span>
        : <details><summary>{bad ? <span className="bad-t">✗ {firstBad?.name}</span> : <span className="ok-t">✓ {p.checks.filter(c => c.pass).length} passed</span>}{p.checks.some(c => c.name === 'Size from the source' && c.pass == null)
          && <span className="small"> · size not in the source</span>}</summary>
          <Checks checks={p.checks} /></details>}</td>
      <td role="cell" className="dd">{edit
        ? <span className="acts"><button type="button" className="btn" onClick={save}>Save</button>
          <button type="button" className="link" onClick={() => setEdit(null)}>Cancel</button></span>
        : <>{(state ?? (noop ? 'In use already' : null)) && <span className="small dstate">{state ?? 'In use already'}</span>}
          <span className="acts">
            {p.status === 'proposed' && !noop && <>
              <button type="button" className="btn" onClick={() => d.accept([p])} disabled={bad} aria-disabled={!!d.busy}
                aria-label={`Accept ${name}: base ${path(v.base, kind)}`}>Accept</button>
              <button type="button" className="link" onClick={() => d.reject(p)} aria-label={`Reject ${name}, keep current`}>Reject</button></>}
            <button type="button" className="link" aria-label={`Edit ${name}`}
              onClick={() => setEdit(Object.fromEntries(ORDER.map(s => [s, shown((bad ? doc.scenarios[s][p.field] : v[s]).start, kind)])) as Record<Scenario, string>)}>Edit</button>
          </span></>}</td>
    </tr>
  )
}
