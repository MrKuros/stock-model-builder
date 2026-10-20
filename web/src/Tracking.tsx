import { useState } from 'react'
import { useHref } from './route'
import { AiOffNote, useAi } from './Sources'
import {
  NAMES, SCENARIOS, api, fmt, money, postJson, rs, when,
  type ModelDoc, type Projection, type Scenario, type ThesisNote, type Tracking, type TrackProposal,
} from './lib'

/** Tracking new results (5.3): your saved forecast against what was reported, by rules. Nothing here changes a number
 * by itself: a missed input becomes a proposal you accept or keep; the note is rewritten only when you press the button. */

type SetDoc = (f: (d: ModelDoc) => ModelDoc) => void
const DAYS = new Set(['dso', 'dio', 'dpo'])
const show = (k: string, x: number | null | undefined) => (DAYS.has(k) ? `${fmt(x, 'days')} days` : fmt(x, 'pct'))
const diffOf = (k: string, d: number) => (DAYS.has(k) ? `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d))} days` : `${d > 0 ? '+' : '−'}${(Math.abs(d) * 100).toFixed(1)} pp`)
const errOf = (e: number | null) => (e == null ? '–' : `${e > 0 ? '+' : '−'}${(Math.abs(e) * 100).toFixed(1)}%`)
const sh = (x: number) => (x < 0 ? `−Rs ${rs(-x)}` : `Rs ${rs(x)}`)
const range = (v: Record<Scenario, number | null> | null | undefined) =>
  v && v.bear != null && v.bull != null ? `${sh(Math.min(v.bear, v.bull))}–${sh(Math.max(v.bear, v.bull))}` : 'n/a'
const needs = (x: number | null | undefined) => (x == null ? 'outside −30% to +80%' : fmt(x, 'pct'))

/** Results recorded after you last marked the model reviewed. Both are compared as times: the browser writes UTC
 * ("...Z"), the server local time without a zone (which the browser also reads as local). */
export const unreviewed = (doc: ModelDoc, t: Tracking | null | undefined) =>
  !!t && (!doc.reviewed_at || Date.parse(doc.reviewed_at) < Date.parse(t.was.recorded_at))

/** The newest forecast that some reported year now covers, and that year's scores. */
export function latestScored(t: Tracking | null | undefined) {
  const r = t?.records.slice().reverse().find(x => x.years.length)
  return r ? { rec: r, year: r.years[r.years.length - 1] } : null
}

/** {year: forecast line} for every reported year a saved forecast covered: the newest forecast for each year wins
 * (the pencil marks drawn over the reported bars on Fundamentals and Forecast). */
export function forecastOf(t: Tracking | null | undefined, key: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of t?.records ?? []) for (const y of r.years) {
    const l = y.lines.find(x => x.key === key)
    if (l) out[y.year] = l.forecast
  }
  return out
}

/** Accepting moves base to the proposed value and bull and bear by the same step (so their spread stays), fades too. */
function accept(setDoc: SetDoc, p: TrackProposal) {
  const step = p.proposed! - p.current
  const floor = (x: number) => (p.key === 'growth' || p.key === 'ebitda_margin' ? x : Math.max(0, x))
  setDoc(d => ({
    ...d,
    scenarios: Object.fromEntries(SCENARIOS.map(s => [s, { ...d.scenarios[s], [p.key]: {
      start: floor(d.scenarios[s][p.key].start + step), end: d.scenarios[s][p.key].end == null ? null : floor(d.scenarios[s][p.key].end! + step) } }])) as ModelDoc['scenarios'],
    assumption_sources: Object.fromEntries(SCENARIOS.map(s => [s, { ...d.assumption_sources[s], [p.key]: 'history' }])),
  }))
}
function keep(setDoc: SetDoc, p: TrackProposal) {
  setDoc(d => {
    const t = d.track ?? []
    return t.length ? { ...d, track: [...t.slice(0, -1), { ...t[t.length - 1], kept: [...t[t.length - 1].kept, p.key] }] } : d
  })
}

/** The rules' proposals after new results: one line each, with Use and Keep. */
export function TrackProposals({ t, setDoc }: { t: Tracking; setDoc: SetDoc }) {
  const href = useHref()
  const [done, setDone] = useState<string | null>(null)
  const odd = t.proposals.filter(p => p.proposed == null), props = t.proposals.filter(p => p.proposed != null)
  const unusual = odd.length > 0 && <p className="small-note">{odd.map(p => `${p.label}: actual ${show(p.key, p.actual)} vs forecast ${show(p.key, p.forecast)}`).join('; ')};
    {' '}{odd[0].year} is an outlier year for {odd.length > 1 ? 'these drivers' : 'this driver'}, so no default change is proposed. Exclude it under <a href={href('risks', 'unusual')}>Outlier years</a>.</p>
  if (!props.length) return <>{done && <p className="small-note" role="status">{done}</p>}{unusual}</>
  return (
    <div className="src-upgrade trk-props" role="group" aria-label="Drivers the new results suggest revising">
      <p className="small"><b>{props.length} driver{props.length === 1 ? '' : 's'} to revise.</b> Nothing changes until you choose.</p>
      <ul>
        {props.map(p => (
          <li key={p.key}>
            <p className="small">{p.label}: {p.year} actual <span className="num">{show(p.key, p.actual)}</span> vs forecast
              {' '}<span className="pencil-num">{show(p.key, p.forecast)}</span>. Updated 3-year default incl. {p.year}:{' '}
              <span className="pencil-num">{show(p.key, p.proposed!)}</span>.</p>
            <div className="prop-actions">
              <button type="button" onClick={() => { accept(setDoc, p); setDone(`${p.label}: base now ${show(p.key, p.proposed!)}; bear and bull shifted by the same step.`) }}>
                Use {show(p.key, p.proposed!)}</button>
              <button type="button" onClick={() => { keep(setDoc, p); setDone(`${p.label}: kept at ${show(p.key, p.current)}.`) }}>
                Keep mine ({show(p.key, p.current)})</button>
            </div>
          </li>
        ))}
      </ul>
      <p className="small-note">“Use” sets the base case and shifts bear and bull by the same step; still editable in Forecast.{done ? ` ${done}` : ''}</p>
      {unusual}
    </div>
  )
}

/** Overview, right under the verdict: what came in against your forecast and what that changed. Full while you
 * haven't reviewed the model since the results; afterwards one line. */
export function Changed({ doc, setDoc, projection, full, answerOnly }: { doc: ModelDoc; setDoc: SetDoc; projection: Projection | null; full?: boolean; answerOnly?: boolean }) {
  const href = useHref()
  const t = projection?.tracking
  const s = latestScored(t)
  if (!t || !s) return null
  const { year } = s
  const rev = year.lines.find(l => l.key === 'revenue'), pat = year.lines.find(l => l.key === 'pat')
  const fresh = unreviewed(doc, t)
  const vs = (e: number | null) => (e == null ? '' : `${(Math.abs(e) * 100).toFixed(1)}% ${e >= 0 ? 'ahead of' : 'below'}`)
  const head = rev ? `${year.year} revenue ${vs(rev.err)} forecast` : `${year.year} results reported`
  if (answerOnly) return <>New results: {head}{pat ? `; PAT ${vs(pat.err)} forecast` : ''}.</>
  if (!fresh && !full) return (
    <p className="trk-line"><span className="label">Latest results</span> {head}{pat ? `; PAT ${vs(pat.err)} forecast` : ''}.{' '}
      <a className="go" href={href('tracking', 'by-input')}>Variance by driver</a></p>
  )
  const was = t.was, now = t.now
  const newFlags = now.flags.filter(f => !was.flags.some(x => x.id === f.id)), gone = was.flags.filter(f => !now.flags.some(x => x.id === f.id))
  return (
    <section className="provenance trk" id="changed" aria-labelledby="changed-h" tabIndex={-1}>
      <h2 id="changed-h">Actual vs forecast: {year.year}{t.was.made_at ? <span className="cnt">forecast of {when(t.was.made_at)}</span> : null}</h2>
      <div className="scroll" tabIndex={0} role="region" aria-label={`${year.year}: forecast against reported`}>
        <table className="mini-t">
          <thead><tr><th scope="col">Rs cr</th><th scope="col" className="r">Forecast</th><th scope="col" className="r">Actual</th><th scope="col" className="r">Variance</th></tr></thead>
          <tbody>{year.lines.map(l => <tr key={l.key}><th scope="row">{l.label}</th><td className="r num ours">{money(l.forecast)}</td>
            <td className="r num">{money(l.actual)}</td><td className="r num">{errOf(l.err)}</td></tr>)}</tbody>
        </table>
      </div>
      <h3 className="h3">Model impact</h3>
      <ul>
        <li>Bear–bull FV range: <b className="num">{range(was.values)}</b> before, <b className="num">{range(now.values)}</b> now
          (base {was.values?.base != null ? sh(was.values.base) : 'n/a'} → <span className="num ours">{now.values.base != null ? sh(now.values.base) : 'n/a'}</span>).</li>
        <li>Reverse-DCF implied revenue growth: {was.implied == null && now.implied == null ? <>{needs(null)}, before or now</> : <><b className="num">{needs(was.implied)}</b> before, <b className="num">{needs(now.implied)}</b> now</>}{now.price != null && was.price != null && Math.abs(now.price - was.price) > 0.005 ? ` (CMP Rs ${rs(was.price)} then, Rs ${rs(now.price)} now)` : ''}.</li>
        <li>Red flags: {newFlags.length || gone.length
          ? <>{newFlags.length ? <>new: <b>{newFlags.map(f => f.name).join(', ')}</b>. </> : null}{gone.length ? <>cleared: {gone.map(f => f.name).join(', ')}.</> : null} <a href={href('risks')}>Risks & forensics</a></>
          : <>no change ({now.flags.length} flagged).</>}</li>
        <li>Assumptions unchanged. {s.year.drivers.filter(d => !d.hit).length
          ? <>{s.year.drivers.filter(d => !d.hit).length} of {s.year.drivers.length} drivers missed (outside tolerance).</>
          : <>All drivers within tolerance.</>} <a className="go" href="#by-input">Variance by driver</a></li>
      </ul>
      <TrackProposals t={t} setDoc={setDoc} />
      {doc.note && <Rewrite doc={doc} setDoc={setDoc} />}
      <p className="small-note">Rule-based comparison: the forecast saved before these results vs filed numbers.</p>
    </section>
  )
}

/** "Rewrite the note with the new results": the same writer as the Overview's thesis (AI, words only); the facts it
 * gets now include what came in against the forecast and the value range before and after. */
function Rewrite({ doc, setDoc }: { doc: ModelDoc; setDoc: SetDoc }) {
  const ai = useAi()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const stale = !doc.note || !doc.track?.length || doc.note.written_at < doc.track[doc.track.length - 1].recorded_at
  const write = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api<ThesisNote>('/api/note/write', postJson(doc))
      if (r.status === 'written') { setDoc(d => ({ ...d, note: r, reviewed_at: null })); setMsg('Rewritten with the new results and checked. See Research note.') }
      else setMsg(`The new draft failed the rule checks twice; the previous note stays: ${r.checks.filter(c => c.pass === false).map(c => c.name).join(', ')}.`)
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="trk-note">
      {stale
        ? <p className="small"><b>Note predates these results</b> ({when(doc.note!.written_at)}); its text is stale.</p>
        : <p className="small">Note written after these results.</p>}
      <button type="button" className="btn" onClick={write} disabled={busy || !ai?.available} aria-describedby="rewrite-why">
        {busy ? 'Rewriting…' : 'Rewrite the note with the new results'}</button>
      <span id="rewrite-why" className="small-note"> {!ai ? 'Checking whether an AI command is set…' : !ai.available ? 'AI is off on this computer.'
        : 'AI drafts text only, from computed facts and the variance; every number is rule-checked. About a minute.'}</span>
      <AiOffNote ai={ai} />
      {msg && <p className="small" role="status">{msg}</p>}
    </div>
  )
}

/** Forecast page: each input you assumed against what came in, and how often each has been right across your saved
 * forecasts. */
export function Accuracy({ doc, setDoc, projection }: { doc: ModelDoc; setDoc: SetDoc; projection: Projection | null }) {
  const t = projection?.tracking
  const s = latestScored(t)
  if (!t || !s) return null
  const rate = Object.fromEntries(t.hit_rate.map(h => [h.key, h]))
  const n = t.records.filter(r => r.years.length).length
  return (
    <section aria-labelledby="trk-h">
      <h2 id="trk-h">Variance by driver <span className="cnt">{s.year.year} · forecast saved {s.rec.made_at ? when(s.rec.made_at) : 'before the results'}</span></h2>
      <p className="small">Blue: {s.year.year} forecast before reporting; black: filed actual. Hit tolerance: 2 pp for revenue growth, 1 pp for
        margins and % of revenue items, 10 days for working-capital days. Hit rate {n === 1 ? 'for this forecast' : `across ${n} saved forecasts and every reported year each covered`}.</p>
      <div className="tw" tabIndex={0} role="region" aria-labelledby="trk-h">
        <table className="mini-t trk-t">
          <thead><tr><th scope="col">Driver</th><th scope="col" className="r">Forecast</th><th scope="col" className="r">Actual</th>
            <th scope="col" className="r">Variance</th><th scope="col">Hit?</th><th scope="col" className="r">Hit rate</th></tr></thead>
          <tbody>{s.year.drivers.map(d => (
            <tr key={d.key} className={d.hit ? undefined : 'miss'}>
              <th scope="row">{d.label}</th><td className="r num ours">{show(d.key, d.forecast)}</td><td className="r num">{show(d.key, d.actual)}</td>
              <td className="r num">{diffOf(d.key, d.diff)}</td><td>{d.hit ? 'Hit' : <b>Missed</b>}</td>
              <td className="r num">{rate[d.key] ? `${rate[d.key].hits} of ${rate[d.key].scored}` : '–'}</td>
            </tr>))}</tbody>
        </table>
      </div>
      <TrackProposals t={t} setDoc={setDoc} />
      {!t.proposals.length && <p className="small-note">No revisions: {s.year.drivers.every(d => d.hit) ? 'all drivers within tolerance.'
        : `the updated default incl. ${s.year.year} doesn’t move the ${NAMES.base.toLowerCase()} case toward the actual, or it was kept.`}</p>}
      {(doc.track?.length ?? 0) > 1 && <p className="small-note">Saved forecasts: {doc.track!.map(r => `before ${r.new_years.join(', ')}${r.made_at ? ` (${when(r.made_at)})` : ''}`).join('; ')}.</p>}
    </section>
  )
}
