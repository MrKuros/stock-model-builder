import { useEffect, useRef, useState } from 'react'
import { fmt, money, rs, type Cagr } from './lib'

/** The element's width in CSS px, so SVGs draw at 1:1 and text stays 11px at any width. */
export function useWidth<T extends HTMLElement>(initial = 640) {
  const ref = useRef<T>(null)
  const [w, setW] = useState(initial)
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))))
    ro.observe(ref.current!)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** A round step giving about `count` ticks over `span`: 1, 2, 2.5 or 5 x 10^k. */
export function step(span: number, count: number) {
  const raw = span / Math.max(1, count), p = 10 ** Math.floor(Math.log10(raw))
  return ([1, 2, 2.5, 5, 10].find(m => m * p >= raw) ?? 10) * p
}

/** Value per share at a flat growth rate, read off the engine's growth scale by straight lines between its points. */
export function valueAt(scale: [number, number | null][], g: number): number | null {
  for (let i = 0; i < scale.length - 1; i++) {
    const [x0, y0] = scale[i], [x1, y1] = scale[i + 1]
    if (y0 != null && y1 != null && g >= x0 && g <= x1) return y0 + ((g - x0) / (x1 - x0)) * (y1 - y0)
  }
  return null
}

interface Props {
  price: number | null; bear: number | null; base: number; bull: number | null
  scale: [number, number | null][] | null // flat revenue growth -> value per share, other inputs at base
  ours: number // base revenue growth (average over the projection)
  implied: number | null
  best3: Cagr | null; best5: Cagr | null
  since: string // first reported year
}

const P = 26 // side padding: end labels never clip

/** The signature instrument: one rupee scale (our range, base, price) and under it the revenue growth each value needs. */
export default function Ruler({ price, bear, base, bull, scale, ours, implied, best3, best5, since }: Props) {
  const [box, w] = useWidth<HTMLDivElement>()
  const narrow = w < 560
  // the growth scale only where value rises with growth (capex-heavy cases can turn it over)
  const pts = (scale ?? []).filter((p): p is [number, number] => p[1] != null)
  const rising = pts.length > 2 && pts.every((p, i) => i === 0 || p[1] > pts[i - 1][1])
  const at = (g: number | null) => (g == null || !rising ? null : valueAt(scale!, g))
  const v3 = at(best3?.value ?? null), v5 = at(best5?.value ?? null)

  const marks = [base, bear, bull, price, v3].filter((x): x is number => x != null)
  let lo = Math.min(...marks), hi = Math.max(...marks)
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.08
  lo -= pad; hi += pad
  const st = step(hi - lo, narrow ? 4 : 9)
  lo = Math.floor(lo / st) * st; hi = Math.ceil(hi / st) * st
  const x = (v: number) => P + ((v - lo) / (hi - lo)) * (w - 2 * P)
  const ticks: number[] = []
  for (let t = lo; t <= hi + st / 2; t += st) ticks.push(Math.round(t * 100) / 100)

  // growth ticks at the x of the value they give; every 2 pp (4 pp when narrow), never crowding
  const gt: [number, number][] = []
  if (rising) for (const [g, v] of pts) {
    if (v < lo || v > hi || Math.round(g * 100) % (narrow ? 4 : 2)) continue
    if (gt.length && x(v) - x(gt[gt.length - 1][1]) < (narrow ? 34 : 30)) continue
    gt.push([g, v])
  }
  const hasGrowth = gt.length >= 2
  const AX = 96, GX = 152, H = hasGrowth ? 200 : 128
  const above = price != null && bull != null && price > bull, belowBear = price != null && bear != null && price < bear
  const pc = (v: number) => fmt(v, 'pct')
  const clampLabel = (cx: number, chars: number) => Math.max(P - 8 + chars * 3.3, Math.min(w - P + 8 - chars * 3.3, cx))

  const desc = [
    `Rupee scale from ${money(lo)} to ${money(hi)} a share.`,
    bear != null && bull != null ? `Our range runs from ${rs(bear)} (bear) through ${rs(base)} (base) to ${rs(bull)} (bull).` : `Our base value is ${rs(base)}.`,
    price != null ? `The price, ${rs(price)}, sits ${above ? `${rs(price - bull!)} above the bull case` : belowBear ? `${rs(bear! - price)} below the bear case` : 'inside the range'}.` : 'No share price.',
    hasGrowth ? `On the growth scale below, our ${pc(ours)} sits under the base value` +
      (best3 && v3 != null ? `, the best three-year run of ${pc(best3.value)} sits at about ${rs(v3)}` : '') +
      (implied != null ? `, and the price needs ${pc(implied)}.` : '.') : '',
  ].join(' ')

  return (
    <div className="instr" ref={box}>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-labelledby="ruler-t ruler-d">
        <title id="ruler-t">Price against value, and the growth each value needs</title>
        <desc id="ruler-d">{desc}</desc>
        <defs>
          <pattern id="hatch-mkt" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="hatch-mkt" />
          </pattern>
          <pattern id="hatch-flag" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="5" className="hatch-flag" />
          </pattern>
        </defs>
        {!narrow && <text className="r-unit" x={P - 4} y={AX - 8}>RS / SHARE</text>}
        <line className="r-axis" x1={P} x2={w - P} y1={AX} y2={AX} />
        {ticks.map(t => <g key={t}>
          <line className="r-tick" x1={x(t)} x2={x(t)} y1={AX} y2={AX + 6} />
          <text className="r-num" x={x(t)} y={AX + 19} textAnchor="middle">{money(t)}</text>
        </g>)}
        {bear != null && bull != null && <rect className="r-band" x={x(bear)} y={AX - 32} width={Math.max(1, x(bull) - x(bear))} height={32} />}
        {price != null && (above || belowBear) && (() => {
          const a = above ? x(bull!) : x(price), b = above ? x(price) : x(bear!)
          const gap = above ? price - bull! : bear! - price
          return <g className="r-gap draw">
            <rect x={a} y={AX - 18} width={b - a} height={18} fill="url(#hatch-mkt)" />
            <line x1={a} x2={b} y1={AX - 18} y2={AX - 18} />
            {b - a > 90 && <text x={(a + b) / 2} y={AX - 23} textAnchor="middle">Rs {rs(gap)} {above ? 'above bull' : 'below bear'}</text>}
          </g>
        })()}
        {bear != null && <g className="r-pin"><text x={clampLabel(x(bear), 6)} y={AX - 50} textAnchor="middle"><tspan className="r-pk">BEAR</tspan><tspan x={clampLabel(x(bear), 6)} dy="13">{rs(bear)}</tspan></text></g>}
        {bull != null && <g className="r-pin"><text x={clampLabel(x(bull), 6)} y={AX - 50} textAnchor="middle"><tspan className="r-pk">BULL</tspan><tspan x={clampLabel(x(bull), 6)} dy="13">{rs(bull)}</tspan></text></g>}
        <g className="r-base">
          <line x1={x(base)} x2={x(base)} y1={AX - 46} y2={hasGrowth ? GX : AX} />
          <text x={clampLabel(x(base), 6)} y={AX - 66} textAnchor="middle"><tspan className="r-pk">BASE</tspan><tspan x={clampLabel(x(base), 6)} dy="15">{rs(base)}</tspan></text>
        </g>

        {hasGrowth && <>
          {!narrow && <text className="r-unit" x={P - 4} y={GX - 8}>GROWTH A YEAR</text>}
          <line className="r-axis" x1={P} x2={w - P} y1={GX} y2={GX} />
          {best5 && v5 != null && v5 < hi && <g className="r-flag">
            <rect x={Math.max(P, x(v5))} y={GX - 7} width={w - P - Math.max(P, x(v5))} height={7} fill="url(#hatch-flag)" />
            {!narrow && (() => {
              const end = price != null && x(price) > x(v5) + 160 && x(price) < w - P - 4 ? x(price) - 8 : w - P
              return end - x(v5) > 150 && <text x={end} y={GX - 11} textAnchor="end">faster than any five years since {since}</text>
            })()}
          </g>}
          {gt.map(([g, v]) => <g key={g}>
            <line className="r-tick" x1={x(v)} x2={x(v)} y1={GX} y2={GX + 6} />
            <text className="r-num" x={x(v)} y={GX + 18} textAnchor="middle">{Math.round(g * 100)}%</text>
          </g>)}
          <path className="r-ours" d={`M${x(base)} ${GX - 6}l6 6-6 6-6-6z`} />
          <text className="r-ours-t" x={clampLabel(x(base), 9)} y={GX + 38} textAnchor="middle">Ours {pc(ours)}</text>
          {best3 && v3 != null && <>
            <path className="r-best" d={`M${x(v3)} ${GX - 5}l5 5-5 5-5-5z`} />
            {Math.abs(x(v3) - x(base)) > 90 && (price == null || Math.abs(x(v3) - x(price)) > 100) &&
              <text className="r-best-t" x={clampLabel(x(v3), 16)} y={GX + 38} textAnchor="middle">Best 3 yrs {pc(best3.value)}</text>}
          </>}
        </>}

        {price != null && <g className="r-needle">
          <line className="draw" x1={x(price)} x2={x(price)} y1={8} y2={hasGrowth ? GX + 26 : AX + 6} />
          <text x={x(price) + (x(price) > w * 0.7 ? -6 : 6)} y={18} textAnchor={x(price) > w * 0.7 ? 'end' : 'start'}>
            <tspan className="r-pk">PRICE</tspan><tspan x={x(price) + (x(price) > w * 0.7 ? -6 : 6)} dy="16" className="r-pv">{rs(price)}</tspan>
          </text>
          {hasGrowth && <text className="r-pf" x={x(price) + (x(price) > w * 0.7 ? -6 : 6)} y={GX + 38}
            textAnchor={x(price) > w * 0.7 ? 'end' : 'start'}>{implied != null ? `Priced for ${pc(implied)}` : 'No growth rate gets there'}</text>}
        </g>}
      </svg>
    </div>
  )
}
