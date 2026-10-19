import { useEffect, useState } from 'react'
import { postJson, type Parsed, type Report, type SourceDoc } from './lib'

/** One line of /api/nse/fetch: a step in plain words, its progress, the company once its numbers are in, a kept
 * document, something that didn't work, or the end. */
export interface FetchEvent {
  step?: string; detail?: string; company?: Parsed; report?: Report; documents?: SourceDoc[]; note?: string
  error?: string; done?: true
  final?: boolean // trying again won't change the error (no such symbol, too few years)
  lender?: boolean // a bank, NBFC or insurer: an Excel export won't work either
}

/** A company name for matching an upload to a saved company: 'Tata Consultancy Services Ltd.' = '... Limited'
 * (server._norm). */
export const sameCompany = (a: string, b: string) => {
  const n = (s: string) => s.toLowerCase().replace(/\b(limited|ltd|the|india|co|company)\b|[^a-z0-9]/g, '')
  return n(a) === n(b)
}

/** "Add these years to it" from Add a company: the saved company opens and merges them there (Workspace), so its
 * inputs, notes and review stay. parsed: an Excel export's years; symbol: NSE's filings for that symbol. */
export const pendingMerge: { company: string; parsed?: Parsed; symbol?: string }[] = []

/** POST a JSON-lines endpoint (/api/nse/fetch by default), calling `on` for each line as it arrives; aborting the
 * signal stops the server's work too. */
export async function streamFetch<E = FetchEvent>(body: unknown, signal: AbortSignal, on: (e: E) => void, url = '/api/nse/fetch') {
  const res = await fetch(url, postJson(body, signal))
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => null)
    throw new Error(typeof b?.detail === 'string' ? b.detail : `Server error (${res.status}). Try again.`)
  }
  const reader = res.body.getReader(), dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) on(JSON.parse(line))
    }
  }
}

/** "just now", "10 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string | null | undefined) {
  if (!iso) return 'not yet'
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}
/** Re-render every minute, so "10 min ago" stays true. */
export function useMinute() {
  const [, tick] = useState(0)
  useEffect(() => { const t = window.setInterval(() => tick(x => x + 1), 60_000); return () => window.clearInterval(t) }, [])
}
