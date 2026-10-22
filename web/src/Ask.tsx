import { useEffect, useId, useRef, useState } from 'react'
import { Checks, useAi } from './Sources'
import { inputName } from './Model'
import { path } from './Draft'
import { Next, PageHead, Sheet } from './Shell'
import { navigate, useHref } from './route'
import { docLabel, NAMES, api, isAnnual, postJson, when, type Check, type DocKind, type Drafted, type Kind, type ModelDoc, type Parsed, type Proposal } from './lib'
import { isLender } from './Lender'

/** A page of an attached document: what the answer cites, or a page the rules picked. */
interface Cite { report: string; file: string; year: string; kind: DocKind; date?: string | null; page: number; quote?: string }
interface Hit extends Cite { score: number; snippet: string }
export interface Answer {
  id: string; question: string; status: 'answered' | 'partial' | 'failed' | 'not_found'; answer: string | null; citations: Cite[]
  checks: Check[]; rounds: number; asked_at: string; pages: Cite[]; proposal: Proposal | null
}
interface Reply { hits: Hit[]; answer: Answer | null; message: string; missing: string[] }

/** Analyst questions that the filings usually answer; a lender gets its own. */
const SUGGESTED: [string, string][] = [
  ['Guidance', 'What revenue growth and margin guidance has management given for the coming year?'],
  ['Capex plans', 'What are the capex plans and capacity additions, and how will they be funded?'],
  ['Margin drivers', 'What drove the EBITDA margin this year, and what does management expect going forward?'],
  ['Order book', 'What is the order book and order inflow, and how much revenue visibility does it give?'],
  ['Capital allocation', 'What is the dividend payout policy, and how does management prioritise buybacks, acquisitions and debt?'],
  ['Risks', 'Which risks and headwinds does management call out?'],
]
const SUGGESTED_LENDER: [string, string][] = [
  ['Loan growth', 'What loan growth does management guide for, and in which segments?'],
  ['NIM', 'What is the NIM outlook and what drives it (deposit costs, repricing, mix)?'],
  ['Asset quality', 'What are GNPA, NNPA and PCR, and what is the credit cost outlook?'],
  ['Deposits', 'How is the CASA ratio and deposit growth trending?'],
  ['Capital', 'What are CAR and CET1, and is a capital raise planned?'],
  ['Risks', 'Which risks and headwinds does management call out?'],
]

const docName = docLabel
const STATUS = { answered: 'Answered from the filings', partial: 'Partly answered from the filings', failed: 'Couldn’t answer from the filings', not_found: 'Couldn’t answer from the filings' }
const shown = (a: Answer) => a.status === 'answered' || a.status === 'partial'

/** The company's saved answers, newest first; `add` puts a new one on top. */
export function useAnswers(slug: string) {
  const [list, setList] = useState<Answer[] | null>(null)
  useEffect(() => {
    let live = true
    api<{ answers: Answer[] }>(`/api/answers/${slug}`).then(r => { if (live) setList(r.answers) }).catch(() => { if (live) setList([]) })
    return () => { live = false }
  }, [slug])
  const add = (a: Answer) => setList(l => [a, ...(l ?? []).filter(x => x.id !== a.id)])
  const remove = async (a: Answer) => {
    await api(`/api/answers/${slug}/${a.id}`, { method: 'DELETE' })
    setList(l => (l ?? []).filter(x => x.id !== a.id))
  }
  return { list, add, remove }
}
type Answers = ReturnType<typeof useAnswers>

interface Props { parsed: Parsed; doc: ModelDoc; setDoc: (f: (d: ModelDoc) => ModelDoc) => void; slug: string }

/** Ask the filings: a question, rules find the pages, AI answers from them only with page citations, rules check every
 * quote and number. Answers are kept per company and never change a number. */
export default function AskPage({ parsed, doc, setDoc, slug }: Props) {
  const href = useHref()
  const ai = useAi()
  const answers = useAnswers(slug)
  const pages = doc.reports.reduce((s, r) => s + r.pages, 0)
  const list = answers.list ?? []
  const ok = list.filter(a => a.status === 'answered').length
  const [open, setOpen] = useState<Cite | null>(null)
  return (
    <>
      <PageHead label="Data · Ask the filings" title="Ask the filings"
        purpose={<>Questions answered only from the documents attached to this model, with page citations. Rules check that every quote is on its
          page and every number is printed there. Answers never change the model.</>}
        answer={!doc.reports.length ? <>No documents attached yet, so there is nothing to ask.</>
          : <>{doc.reports.length} document{doc.reports.length > 1 ? 's' : ''}, {pages.toLocaleString('en-IN')} pages searchable
            {ai && !ai.available ? ' (AI off: keyword search only)' : ''}.{list.length ? ` ${ok} of ${list.length} question${list.length > 1 ? 's' : ''} answered.` : ''}</>} />
      {doc.reports.length > 0 && <section className="blk first" aria-labelledby="ask-h">
        <h2 id="ask-h" className="sr">Ask a question</h2>
        <AskBox parsed={parsed} doc={doc} setDoc={setDoc} slug={slug} answers={answers} onOpen={setOpen} suggest />
      </section>}
      {list.length > 0 && <section className="blk" id="asked" tabIndex={-1} aria-labelledby="asked-h">
        <h2 id="asked-h">Asked before <span className="small dim">({list.length})</span></h2>
        <ul className="ask-list">{list.map(a => <li key={a.id}>
          <details>
            <summary><span className="aq">{a.question}</span> <span className={`small ${shown(a) ? 'muted' : 'bad'}`}>
              {shown(a) ? `${a.status === 'partial' ? 'partly answered · ' : ''}${a.citations.length} citation${a.citations.length === 1 ? '' : 's'}` : 'not answered'} · {when(a.asked_at)}</span></summary>
            <AnswerCard a={a} doc={doc} setDoc={setDoc} onOpen={setOpen} onDelete={() => answers.remove(a)} />
          </details></li>)}</ul>
      </section>}
      <PageText cite={open} onClose={() => setOpen(null)} />
      <Next lead={doc.reports.length ? 'More documents widen what can be answered: transcripts for guidance, annual reports for policy and segments.'
        : 'Attach an annual report, call transcript or investor presentation to ask questions of it.'}>
        <a className={doc.reports.length ? 'btn' : 'primary'} href={href('documents', 'add')}>Attach documents</a>
      </Next>
    </>
  )
}

/** The question box with its latest result; on Documents (no `suggest`) it links to the full page. */
export function AskBox({ parsed, doc, setDoc, slug, answers, onOpen, suggest }: Props & {
  answers: Answers; onOpen: (c: Cite) => void; suggest?: boolean
}) {
  const ai = useAi()
  const href = useHref()
  const id = useId()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [got, setGot] = useState<Reply | null>(null)
  const box = useRef<HTMLInputElement>(null)
  const ctl = useRef<AbortController | null>(null)
  const on = !!ai?.available
  const run = async (searchOnly: boolean) => {
    const question = q.trim()
    if (busy || question.length < 3) { box.current?.focus(); return }
    setBusy(searchOnly ? 'Searching the pages…' : 'Reading the best-matching pages (about 30 seconds)…')
    setError(null)
    ctl.current = new AbortController()
    try {
      const r = await api<Reply>('/api/ask', postJson({
        slug, question, search_only: searchOnly, company: doc.company, filings: doc.filings, notes: doc.notes,
        excluded_years: doc.excluded_years, reports: doc.reports, n: doc.n,
      }, ctl.current.signal))
      setGot(r)
      if (r.answer) answers.add(r.answer)
    } catch (e) {
      setError((e as Error).name === 'AbortError' ? 'Stopped.' : (e as Error).message)
    } finally {
      setBusy(null)
      window.setTimeout(() => box.current?.focus({ preventScroll: true })) // the button that had focus was swapped for the progress line
    }
  }
  const sugg = isLender(parsed) ? SUGGESTED_LENDER : SUGGESTED
  return (
    <div className="ask">
      <form className="ask-form" onSubmit={e => { e.preventDefault(); run(!on) }}>
        <label htmlFor={`${id}-q`} className="ask-l">Your question, answered from {doc.reports.length === 1 ? `the ${docName(doc.reports[0])}` : `${doc.reports.length} documents`}</label>
        <div className="ask-row">
          <input id={`${id}-q`} ref={box} type="text" value={q} maxLength={400} onChange={e => setQ(e.target.value)} autoComplete="off"
            placeholder={isLender(parsed) ? 'e.g. What is the credit cost guidance?' : 'e.g. What capex is planned for next year?'} />
          {busy ? <span className="chk-run" role="status">{busy} <button type="button" className="link" onClick={() => ctl.current?.abort()}>Stop</button></span>
            : <>
              <button type="submit" className="primary">{on ? 'Ask' : 'Search pages'}</button>
              {on && <button type="button" className="link" onClick={() => run(true)}>Keyword search only</button>}
            </>}
        </div>
        {ai && !on && <p className="small muted">AI is off (<code>LLM_CMD</code> isn’t set), so this finds the pages that use your words; no answer is written.
          {' '}<a href={href('documents', 'ai')}>How to turn it on</a></p>}
      </form>
      {suggest && <div className="ask-sugg" role="group" aria-label="Suggested questions">
        {sugg.map(([k, text]) => <button key={k} type="button" className="chip" title={text}
          onClick={() => { setQ(text); box.current?.focus() }}>{k}</button>)}
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
      <div aria-live="polite">
        {got && (got.answer ? <div className="ask-now"><AnswerCard a={got.answer} doc={doc} setDoc={setDoc} onOpen={onOpen} /></div>
          : <Hits r={got} onOpen={onOpen} />)}
        {got?.missing.length ? <p className="small muted">Not searched (its text isn’t on this machine any more; attach it again): {got.missing.join(', ')}.</p> : null}
      </div>
      {!suggest && (answers.list?.length ?? 0) > 0 && <p className="small"><a href={href('ask', 'asked')}>All {answers.list!.length} questions asked</a></p>}
    </div>
  )
}

/** Keyword search: the pages rules found, best first, each with its best line. */
function Hits({ r, onOpen }: { r: Reply; onOpen: (c: Cite) => void }) {
  if (!r.hits.length) return <p className="small" role="status">{r.message}</p>
  return (
    <div className="ask-hits">
      <p className="small muted">{r.message || 'Pages that best match your words, best first.'}</p>
      <ol>{r.hits.map(h => <li key={`${h.report}-${h.page}`}>
        <button type="button" className="link" onClick={() => onOpen(h)}>{docName(h)}, p.{h.page}</button>
        <span className="serif snip">{h.snippet}</span></li>)}</ol>
    </div>
  )
}

/** One answer: the words, each citation (opens its page), the rule checks, and a guided driver figure as a proposal. */
function AnswerCard({ a, doc, setDoc, onOpen, onDelete }: {
  a: Answer; doc: ModelDoc; setDoc: Props['setDoc']; onOpen: (c: Cite) => void; onDelete?: () => void // onDelete: in the list, under its question
}) {
  const href = useHref()
  const failed = a.checks.find(c => c.pass === false)
  const passed = a.checks.filter(c => c.pass).length
  return (
    <article className={`ask-card${a.status === 'answered' ? '' : ' is-bad'}`} aria-label={`Answer: ${a.question}`}>
      <p className="label">{STATUS[a.status]} <span className="ai-tag">AI reads · rules check</span></p>
      {!onDelete && <p className="aq-h">{a.question}</p>}
      {shown(a) ? <p className="serif ans">{a.answer}</p>
        : <p className="small">{a.status === 'not_found' ? 'The best-matching pages don’t answer this. Try narrower words, or attach the document that would.'
          : <>The answer failed the rules twice{failed ? `: ${failed.detail}` : ''} It isn’t shown as an answer.</>}</p>}
      {a.status === 'partial' && <p className="small">Not all of it is on the {a.pages.length} pages read: try other words, or attach the
        document that would answer the rest.</p>}
      {shown(a) && <ol className="ask-cites">{a.citations.map((c, i) => <li key={i}>
        <button type="button" className="link" onClick={() => onOpen(c)} aria-label={`Open ${docName(c)} page ${c.page}`}>{docName(c)}, p.{c.page}</button>
        {c.quote && <q className="quote">{c.quote}</q>}</li>)}</ol>}
      {shown(a) && a.proposal && <Driver p={a.proposal} doc={doc} setDoc={setDoc} toForecast={href('forecast', 'draft')} />}
      <div className="ask-foot small">
        {a.checks.length > 0 && <details><summary>{failed ? <span className="bad-t">✗ {failed.name}</span> : <span className="ok-t">✓ {passed} rule checks passed</span>}
          {a.rounds > 1 ? ' on the retry' : ''}</summary><Checks checks={a.checks} /></details>}
        {a.pages.length > 0 && <details><summary>Pages read ({a.pages.length})</summary><ul className="ask-pages">{a.pages.map(c => <li key={`${c.report}-${c.page}`}>
          <button type="button" className="link" onClick={() => onOpen(c)}>{docName(c)}, p.{c.page}</button></li>)}</ul></details>}
        <span className="muted">Asked {when(a.asked_at)}</span>
        {onDelete && <button type="button" className="link" onClick={() => { if (window.confirm('Delete this question and its answer?')) onDelete() }}>Delete</button>}
      </div>
    </article>
  )
}

/** A driver figure management gave: as a proposal for the Forecast review (Use / Keep mine there), never applied here. */
function Driver({ p, doc, setDoc, toForecast }: { p: Proposal; doc: ModelDoc; setDoc: Props['setDoc']; toForecast: string }) {
  const kind: Kind = p.unit === 'days' ? 'days' : p.unit === 'num' ? 'num' : 'pct'
  const v = p.value as Drafted
  const sent = doc.proposals.find(x => x.id === p.id)
  const bad = p.status === 'rejected' || p.checks.some(c => c.pass === false)
  const send = () => {
    setDoc(d => ({ ...d, proposals: [...d.proposals.filter(x => x.id !== p.id), { ...p, round: new Date().toISOString() }] }))
    navigate(toForecast)
  }
  return (
    <div className="ask-drv">
      <p><b>{inputName(p.field)}</b>: {NAMES.base} <span className="num ai-num">{path(v.base, kind)}</span>
        {v.bull.start !== v.base.start && <span className="small muted"> (Bull {path(v.bull, kind)}, Bear {path(v.bear, kind)})</span>} from p.{p.source.page}</p>
      {bad ? <p className="small bad">Not usable as an input: {p.checks.find(c => c.pass === false)?.detail}</p>
        : sent ? <p className="small">Sent to Forecast{sent.status !== 'proposed' ? ` · ${sent.status === 'approved' ? 'used' : 'kept yours'}` : ''}. <a href={toForecast}>Review</a></p>
        : <p className="small"><button type="button" className="btn" onClick={send}>Propose as an input</button>{' '}
          <span className="muted">Rules re-check it; you Use it or keep yours on Forecast.</span></p>}
    </div>
  )
}

/** The cited page's text, the quote marked where it can be found as written. */
function PageText({ cite, onClose }: { cite: Cite | null; onClose: () => void }) {
  const [page, setPage] = useState<{ text: string; pages: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!cite) return
    let live = true
    setPage(null); setError(null)
    api<{ text: string; pages: number }>(`/api/reports/${cite.report}/${cite.page}`).then(r => { if (live) setPage(r) })
      .catch(e => { if (live) setError((e as Error).message) })
    return () => { live = false }
  }, [cite])
  let body: React.ReactNode = page?.text
  if (page && cite?.quote) {
    const words = cite.quote.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const m = new RegExp(words.join('\\s+'), 'i').exec(page.text)
    if (m) body = <>{page.text.slice(0, m.index)}<mark id="ask-mark">{m[0]}</mark>{page.text.slice(m.index + m[0].length)}</>
  }
  useEffect(() => { document.getElementById('ask-mark')?.scrollIntoView({ block: 'center' }) }, [page])
  return (
    <Sheet open={!!cite} title={cite ? `${docName(cite)}, page ${cite.page}${page ? ` of ${page.pages}` : ''}` : ''} onClose={onClose} full>
      {cite && <p className="small muted">{cite.file}{cite.quote ? ' · the cited quote is marked' : ''}</p>}
      {error ? <p className="error" role="alert">{error}</p> : !page ? <p className="small" role="status">Loading the page…</p>
        : <pre className="page-text" tabIndex={0}>{body}</pre>}
    </Sheet>
  )
}

/** On Documents: the box only, with a link to the full page. */
export function AskDocs({ parsed, doc, setDoc, slug }: Props) {
  const answers = useAnswers(slug)
  const [open, setOpen] = useState<Cite | null>(null)
  if (!doc.reports.length) return null
  const annual = doc.reports.some(isAnnual)
  return (
    <section className="blk" id="ask" tabIndex={-1} aria-labelledby="askd-h">
      <h2 id="askd-h">Ask the filings</h2>
      <p className="small muted">Answers come only from the {annual ? 'documents above' : 'transcripts and presentations above'}, with page citations checked by rules.</p>
      <AskBox parsed={parsed} doc={doc} setDoc={setDoc} slug={slug} answers={answers} onOpen={setOpen} />
      <PageText cite={open} onClose={() => setOpen(null)} />
    </section>
  )
}
