import { useRef, useState } from 'react'
import { Checks } from './Sources'
import { inputName } from './Model'
import type { AiStatus as Ai } from './Sources'
import {
  NAMES, api, DOC_KINDS, fmt, isAnnual, postJson, SCENARIOS, type Drafted, type Kind, type ModelDoc, type Parsed, type Path,
  type Proposal, type Scenario,
} from './lib'

const ORDER: Scenario[] = ['bear', 'base', 'bull']
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
  const ctl = useRef<AbortController | null>(null)
  const stop = () => ctl.current?.abort()
  const ctx = { company: doc.company, excluded_years: doc.excluded_years, filings: doc.filings, notes: doc.notes, reports: doc.reports, n: doc.n }

  const draft = async () => {
    if (busy) return
    const n = doc.reports.length
    setBusy(n ? `Reading ${n} document${n > 1 ? 's' : ''} (about a minute)` : 'Taking the rule defaults…')
    setMsg(null)
    ctl.current = new AbortController()
    try {
      const r = await api<{ proposals: Proposal[]; message: string }>('/api/assumptions/draft', postJson(ctx, ctl.current.signal))
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
    } catch (e) {
      setMsg((e as Error).name === 'AbortError' ? { text: 'Stopped. Nothing changed.' } : { text: (e as Error).message, bad: true })
    } finally { setBusy(null) }
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
        : { text: `Used ${ok.length} suggestion${ok.length === 1 ? '' : 's'} in all three cases. They are your inputs now (yellow); recalculating never calls AI.` })
    } catch (e) { setMsg({ text: (e as Error).message, bad: true }) } finally { setBusy(null) }
  }

  const reject = (p: Proposal) => {
    setDoc(d => ({ ...d, proposals: d.proposals.map(x => (x.id === p.id ? { ...x, status: 'rejected' as const } : x)) }))
    setMsg({ text: `Kept your ${p.field.replace(/_/g, ' ')}.` })
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
  return { busy, msg, draft, accept, reject, edit, stop }
}
export type Drafting = ReturnType<typeof useDraft>

/** Suggest from documents: AI reads the attached documents and suggests inputs with a quote; rules check each one;
 * Use, Keep mine or Edit, one by one or all that passed. Used values become ordinary inputs (yours). */
export default function DraftPanel({ parsed, doc, d, ai, href }: { parsed: Parsed; doc: ModelDoc; d: Drafting; ai: Ai | null; href: string }) {
  const rows = latest(doc)
  const kinds = Object.fromEntries(parsed.drivers.map(x => [x[0], x[2]])) as Record<string, Kind>
  const names = Object.fromEntries(parsed.drivers.map(x => [x[0], inputName(x[0], x[1])]))
  const src = doc.assumption_sources
  const order = parsed.drivers.map(x => x[0])
  rows.sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field))
  const same = (p: Proposal) => SCENARIOS.every(s => JSON.stringify((p.value as Drafted)[s]) === JSON.stringify(doc.scenarios[s][p.field]))
  // use-all never overwrites your own edits with a rule default, and skips rows that change nothing
  const passing = rows.filter(p => p.status === 'proposed' && !failing(p) && !same(p) && !(p.from_history && src.base?.[p.field] === 'manual'))
  const nDoc = rows.filter(p => !p.from_history).length, nBad = rows.filter(failing).length
  const docs = doc.reports
  const off = ai != null && !ai.available
  return (
    <section className="draft" aria-labelledby="draft-h" id="a-draft">
      <div className="draft-head">
        <div>
          <h2 id="draft-h">Suggest from documents <span className="ai-tag">AI reads · rules check · you decide</span></h2>
          {off ? <p className="small">AI reading is off, so nothing can suggest inputs. <a href={href.replace('#add', '#ai')}>How to turn it on</a> · or set them yourself below.</p>
            : docs.length ? <p className="small">AI reads {docs.map(r => `the ${r.year} ${DOC_KINDS[r.kind ?? 'annual'].toLowerCase()}`).join(', ')} and suggests each input
                with a quote; rules check the quote, the bounds and the company’s record. Inputs the documents don’t cover keep the rule’s figure.</p>
            : <p className="small">No documents attached, so AI has nothing to read: a suggestion would just repeat the rules’ figures. <a href={href}>Attach an annual report or call transcript</a></p>}
        </div>
        {!off && (d.busy
          ? <span className="chk-run" role="status">{d.busy} · <button type="button" className="link" onClick={d.stop}>Stop</button></span>
          : <button type="button" className="btn" onClick={d.draft}>{rows.length ? 'Suggest again' : docs.length ? 'Read and suggest (about a minute)' : 'Suggest anyway'}</button>)}
      </div>
      {d.msg && <p className={`small ${d.msg.bad ? 'bad' : ''}`} role="status">{d.msg.text}</p>}
      {rows.length > 0 && <>
        <div className="draft-bar">
          <span className="small">AI read {docs.length} document{docs.length === 1 ? '' : 's'} and suggests {nDoc} input{nDoc === 1 ? '' : 's'}. Rules checked each one{nBad ? `; ${nBad} rejected` : ''}. {rows.length - nDoc} keep the rule’s figure.</span>
          <button type="button" className="btn" onClick={() => d.accept(passing)} disabled={!passing.length} aria-disabled={!!d.busy}>
            Use all that passed ({passing.length})</button>
        </div>
        <div className="table-wrap draft-wrap" tabIndex={0} role="region" aria-label="Suggested inputs against yours">
          <table className="draft-t" role="table">
            <caption className="sr">Each input: the suggested cautious, central and hopeful values against yours, the source, the rule checks and your decision</caption>
            <thead role="rowgroup"><tr role="row">{['Input', ...ORDER.map(s => NAMES[s]), 'Source', 'Rule check', 'Decision'].map(h =>
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
  const state = p.status === 'proposed' ? null : src === 'manual' ? 'Edited by you' : inUse ? 'Used ✓'
    : p.status === 'approved' ? 'Used, since changed' : bad ? 'Rejected by the rules; yours kept' : 'Kept yours'
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
        : <><span className={`num${p.from_history ? '' : p.status === 'proposed' ? ' ai-num' : ' you-hl'}`}>{path(v[s], kind)}</span>
          <span className="now">{same(s) ? 'same as now' : <>now <span className="num">{path(doc.scenarios[s][p.field], kind)}</span></>}</span></>}</td>)}
      <td role="cell" className="ds">{p.from_history
        ? <><span className="srcw rule">Rule</span> <span className="small">the rule’s figure</span></>
        : <><span className="srcw ai">AI suggests</span> <span className="small">{docName(doc, p)}, p.{p.source.page}</span>
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
                aria-label={`Use ${name}: central ${path(v.base, kind)}`}>Use</button>
              <button type="button" className="link" onClick={() => d.reject(p)} aria-label={`Keep mine for ${name}`}>Keep mine</button></>}
            <button type="button" className="link" aria-label={`Edit ${name}`}
              onClick={() => setEdit(Object.fromEntries(ORDER.map(s => [s, shown((bad ? doc.scenarios[s][p.field] : v[s]).start, kind)])) as Record<Scenario, string>)}>Edit</button>
          </span></>}</td>
    </tr>
  )
}
