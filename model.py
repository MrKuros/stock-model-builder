"""Export.in Excel export -> three-statement projection model (all figures in Rs crore)."""
import calendar
import io
import math
import statistics
from datetime import datetime

import openpyxl
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

# Export "Data Sheet" row label -> our key. Labels matched case-insensitively.
# Repeated labels get a "#2" suffix ("Total" appears twice in the balance sheet).
PL = {"Sales": "revenue", "Other Income": "other_income", "Depreciation": "dep", "Interest": "interest",
      "Profit before tax": "pbt", "Tax": "tax", "Net profit": "pat", "Dividend Amount": "dividend"}
BS = {"Equity Share Capital": "share_cap", "Reserves": "reserves", "Borrowings": "borrowings",
      "Other Liabilities": "other_liab", "Total": "total_liab", "Net Block": "net_block",
      "Capital Work in Progress": "cwip", "Investments": "investments", "Other Assets": "other_assets",
      "Total#2": "total_assets", "Receivables": "receivables", "Inventory": "inventory", "Cash & Bank": "cash"}
CF = {"Cash from Operating Activity": "cfo", "Cash from Investing Activity": "cfi",
      "Cash from Financing Activity": "cff"}
OPTIONAL = {"Dividend Amount", "Cash from Operating Activity", "Cash from Investing Activity",
            "Cash from Financing Activity"}
SECTION_HEADS = (("PROFIT & LOSS", "pl"), ("QUARTERS", None), ("BALANCE SHEET", "bs"),
                 ("CASH FLOW", "cf"), ("PRICE", None), ("DERIVED", None))
TOL = 1.0  # Rs crore; Export rounds to 2 decimals per line

# key, label, kind. Historical values are the actual ratios; projected values are the inputs.
DRIVERS = [
    ("growth", "Revenue growth", "pct"),
    ("ebitda_margin", "EBITDA margin", "pct"),
    ("oi_pct", "Other income % revenue (history incl. exceptionals)", "pct"),
    ("dep_pct", "Depreciation % opening net block", "pct"),
    ("int_rate", "Interest % opening borrowings", "pct"),
    ("tax_rate", "Tax rate", "pct"),
    ("mi_pct", "Minority & associates % of post-tax profit", "pct"),
    ("payout", "Dividend payout", "pct"),
    ("capex_pct", "Capex % revenue", "pct"),
    ("dso", "Receivable days", "days"),
    ("dio", "Inventory days (on revenue)", "days"),
    ("oca_pct", "Other current assets % revenue", "pct"),
    ("ol_pct", "Other liabilities % revenue", "pct"),
    ("debt_change", "Planned borrowing change per year", "num"),
]

# Scenario order is also the Excel selector value (1, 2, 3). The UI seeds bull/bear from base
# (growth +/- 3 pp, EBITDA margin +/- 1.5 pp, all else equal); the engine just takes three assumption sets.
SCENARIOS = ("base", "bull", "bear")

LAYOUT = [  # (label, key, kind); kind "head" = section title, None key = blank row
    ("ASSUMPTIONS", None, "head"),
    *[(label, key, kind) for key, label, kind in DRIVERS],
    ("", None, None),
    ("PROFIT & LOSS", None, "head"),
    ("Revenue", "revenue", "num"), ("EBITDA", "ebitda", "num"), ("Other income", "other_income", "num"),
    ("Depreciation", "dep", "num"), ("Interest", "interest", "num"), ("Profit before tax", "pbt", "num"),
    ("Tax", "tax", "num"), ("Net profit", "pat", "num"), ("Dividend", "dividend", "num"),
    ("", None, None),
    ("BALANCE SHEET", None, "head"),
    ("Equity share capital", "share_cap", "num"), ("Reserves", "reserves", "num"),
    ("Borrowings", "borrowings", "num"), ("Other liabilities", "other_liab", "num"),
    ("Total liabilities", "total_liab", "num"),
    ("Net block", "net_block", "num"), ("Capital WIP", "cwip", "num"), ("Investments", "investments", "num"),
    ("Receivables", "receivables", "num"), ("Inventory", "inventory", "num"),
    ("Other current assets", "other_ca", "num"), ("Cash & bank", "cash", "num"),
    ("Total assets", "total_assets", "num"),
    ("", None, None),
    ("CASH FLOW", None, "head"),
    ("Cash from operations", "cfo", "num"), ("Cash from investing", "cfi", "num"),
    ("Cash from financing", "cff", "num"), ("Net cash flow", "net_cf", "num"),
    ("Capex", "capex", "num"), ("Free cash flow", "fcf", "num"),
    ("Borrowed to cover cash shortfall", "revolver", "num"),
    ("Operating EBIT (excl. other income)", "ebit", "num"), ("Operating EBIT after tax", "nopat", "num"),
    ("Net working capital", "nwc", "num"), ("Free cash flow to firm", "fcff", "num"),
    ("", None, None),
    ("RATIOS", None, "head"),
    ("Return on equity", "roe", "pct"), ("Return on capital employed", "roce", "pct"),
    ("Asset turnover", "asset_turnover", "x"), ("Net debt / EBITDA", "nd_ebitda", "x"),
    ("Interest cover", "int_cover", "x"),
    ("", None, None),
    ("CHECKS (should be 0)", None, "head"),
    ("Assets - liabilities", "chk_bs", "chk"), ("Cash roll-forward", "chk_cash", "chk"),
]


# ---------- parsing ----------

def _sections(ws):
    sec, out = None, {}
    for row in ws.iter_rows(values_only=True):
        label = row[0].strip() if row and isinstance(row[0], str) else None
        if not label:
            continue
        head = next((key for h, key in SECTION_HEADS if label.upper().startswith(h)), False)
        if head is not False:
            sec = head
            if sec:
                out.setdefault(sec, {})
            continue
        if sec:
            k, n = label.lower(), 2
            while k in out[sec]:
                k, n = f"{label.lower()}#{n}", n + 1
            out[sec][k] = row[1:]
    return out


def _cell(row, i, section, label, d):
    v = row[i] if i < len(row) else None  # read_only rows can be ragged when the sheet has no <dimension>
    if isinstance(v, str):
        v = v.replace(",", "").strip()
        v = None if v in ("", "-") else v
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{section} '{label}' {d:%b %Y}: not a number: {v!r}") from None


def _by_date(rows, mapping, section, blank=0.0):
    if rows is None:
        raise ValueError(f"No '{section}' section found. Is this a Export.in export?")
    dates = rows.get("report date")
    if not dates:
        raise ValueError(f"{section}: no 'Report Date' row")
    missing = [l for l in mapping if l.lower() not in rows and l not in OPTIONAL]
    if missing:
        raise ValueError(f"{section}: missing rows {missing}. Banks/NBFCs/insurers use a different "
                         f"layout and are not supported yet. Rows found: {list(rows)}")
    out = {}
    for i, d in enumerate(dates):
        if isinstance(d, datetime):
            out[d] = {key: blank if v is None else v for label, key in mapping.items()
                      for v in [_cell(rows.get(label.lower(), ()), i, section, label, d)]}
    return out


def parse_export(file):
    """file: path or file-like of a Export.in 'Export to Excel' workbook."""
    try:
        wb = openpyxl.load_workbook(file, data_only=True, read_only=True)
    except Exception as e:
        raise ValueError(f"Could not open this file as an .xlsx workbook ({e}). "
                         "Upload the file from Export.in's 'Export to Excel' button.") from e
    if "Data Sheet" not in wb.sheetnames:
        raise ValueError("No 'Data Sheet' tab. Upload the file from Export.in's 'Export to Excel' button.")
    ws = wb["Data Sheet"]
    name = next((r[1] for r in ws.iter_rows(max_row=5, values_only=True)
                 if isinstance(r[0], str) and r[0].strip().upper() == "COMPANY NAME"), None) or "Company"
    s = _sections(ws)
    pl, bs = _by_date(s.get("pl"), PL, "PROFIT & LOSS"), _by_date(s.get("bs"), BS, "BALANCE SHEET")
    cf = _by_date(s.get("cf"), CF, "CASH FLOW", blank=None) if s.get("cf") else {}
    if not any(v["revenue"] for v in pl.values()):
        raise ValueError("'Sales' row has no values. If the file was edited by a script, open it in Excel "
                         "and save it again so formula results are stored.")
    dates = sorted(d for d in pl if d in bs and pl[d]["revenue"] and bs[d]["total_liab"])
    if len(dates) < 2:
        raise ValueError("Need at least 2 years with both P&L and balance sheet data.")

    hist = []
    for d in dates:
        h = {**pl[d], **bs[d], **cf.get(d, dict.fromkeys(("cfo", "cfi", "cff")))}
        h["ebitda"] = h["pbt"] + h["interest"] + h["dep"] - h["other_income"]
        h["other_ca"] = h["other_assets"] - h["receivables"] - h["inventory"] - h["cash"]
        h["net_cf"] = None if None in (h["cfo"], h["cfi"], h["cff"]) else h["cfo"] + h["cfi"] + h["cff"]
        p = hist[-1] if hist else None
        h["capex"] = h["net_block"] - p["net_block"] + h["cwip"] - p["cwip"] + h["dep"] if p else None
        h["fcf"] = h["cfo"] - h["capex"] if p and h["cfo"] is not None else None
        h.update(returns(h, p))
        hist.append(h)
    # ponytail: heuristic, tuned on 15 real exports: lenders' loan books sit in Other Assets at 2.7-9.4x revenue;
    # non-financials stay under ~1.6x (ADANIPORTS: infra loans/advances ~1.2x). Revisit if a real lender slips under 2x.
    rev = [h for h in hist if h["revenue"]]
    wc = statistics.median((h["receivables"] + h["inventory"]) / h["revenue"] for h in rev)
    ir = statistics.median(h["interest"] / h["revenue"] for h in rev)
    oca = statistics.median(h["other_ca"] / h["revenue"] for h in rev)
    if all(not h["receivables"] and not h["inventory"] for h in hist) or (ir > 0.3 and wc < 0.05) or oca > 2.0:
        raise ValueError("Looks like a bank/NBFC/insurer (loan book or interest dominates, no receivables/inventory). "
                         "Financial companies are not supported yet.")
    return {"name": str(name), "dates": dates, "hist": hist, "market": _market(ws, s["pl"]["report date"], dates)}


def _pos(v):
    """A positive finite number, else None (formulas without a cached value come back as None)."""
    try:
        v = float(str(v).replace(",", "")) if isinstance(v, str) else v
    except ValueError:
        return None
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0 else None


def _market(ws, cols, dates):
    """Share price and count (shares in crore) from META, the PRICE row and DERIVED; any of it may be missing."""
    rows = {}
    for r in ws.iter_rows(values_only=True):
        if r and isinstance(r[0], str):
            rows.setdefault(r[0].strip().rstrip(":").strip().lower(), r[1:])
    first = lambda label: _pos((rows.get(label) or (None,))[0])  # noqa: E731
    at = {d: i for i, d in enumerate(cols) if isinstance(d, datetime)}  # PRICE / DERIVED share the annual columns
    hist = lambda label: [_pos(rows[label][at[d]]) if label in rows and at[d] < len(rows[label]) else None  # noqa: E731
                          for d in dates]
    price, mcap = first("current price"), first("market capitalization")
    shares_hist = hist("adjusted equity shares in cr")
    shares = mcap / price if price and mcap else next((v for v in reversed(shares_hist) if v), None)
    return {"price": price, "shares": shares, "price_hist": hist("price"), "shares_hist": shares_hist}


def data_checks(co):
    """Sanity checks on the parsed historicals; returns list of warning strings."""
    issues = []
    for d, h in zip(co["dates"], co["hist"]):
        for what, diff in (
            ("assets - liabilities", h["total_assets"] - h["total_liab"]),
            ("liability lines vs Total", h["share_cap"] + h["reserves"] + h["borrowings"] + h["other_liab"] - h["total_liab"]),
            ("asset lines vs Total", h["net_block"] + h["cwip"] + h["investments"] + h["other_assets"] - h["total_assets"]),
            ("PBT - tax vs net profit (minority share / associates / exceptionals, normal for consolidated)",
             h["pbt"] - h["tax"] - h["pat"]),
        ):
            if abs(diff) > (max(TOL, 0.05 * abs(h["pat"])) if what.startswith("PBT") else TOL):
                issues.append(f"{fy(d)}: {what} off by {diff:,.1f} cr")
        if h["other_ca"] < -TOL:
            issues.append(f"{fy(d)}: receivables + inventory + cash exceed Other Assets")
    d, h = co["dates"], co["hist"][-1]
    issues += [f"{fy(b)}: period is {(b - a).days} days (year-end change?), its growth/ratios are distorted"
               for a, b in zip(d, d[1:]) if not 330 <= (b - a).days <= 400]
    gap = (h["net_block"] + h["cwip"] + h["investments"] + h["other_assets"]
           - h["share_cap"] - h["reserves"] - h["borrowings"] - h["other_liab"])
    if abs(gap) > TOL:
        issues.append(f"{fy(d[-1])}: asset and liability lines differ by {gap:,.1f} cr; "
                      "first projected year's cash roll-forward check absorbs this (one-time)")
    return issues


def fy(d, projected=False):
    return f"FY{d.year}{'E' if projected else ''}"


def labels(dates):
    """fy() for each reported year, unique: a year-end change can put two year ends in one calendar year
    (Mar 2019, Dec 2019), so a repeat gets its month ("FY2019 Dec"). Exclusions and flags key on these."""
    out = [fy(d) for d in dates]
    return [x if out.index(x) == i else f"{x} {d:%b}" for i, (x, d) in enumerate(zip(out, dates))]


# ---------- ratios & projection ----------

def _div(a, b):
    return a / b if b else None


def returns(c, p=None):
    """Return ratios for year c; p = previous year (None: averages fall back to closing balances).
    Blank (None) when the denominator is <= ~0: a ratio on negative equity or EBITDA means nothing.
    EBIT = PBT + interest. Mirrored by _returns_formulas()."""
    avg = lambda f: (f(c) + f(p)) / 2 if p else f(c)  # noqa: E731
    eq = lambda r: r["share_cap"] + r["reserves"]  # noqa: E731
    # 1e-6 cr = Rs 10: debt faded to zero leaves float residue (1e-14) that would read as 1e18x cover
    pos = lambda num, den: num / den if den > 1e-6 else None  # noqa: E731
    ebit = c["pbt"] + c["interest"]
    return {
        "roe": pos(c["pat"], avg(eq)),
        "roce": pos(ebit, avg(lambda r: eq(r) + r["borrowings"])),
        "asset_turnover": pos(c["revenue"], avg(lambda r: r["total_assets"])),
        "nd_ebitda": pos(c["borrowings"] - c["cash"] - c["investments"], c["ebitda"]),
        "int_cover": pos(ebit, c["interest"]),
    }


def ratios(hist):
    out = []
    for i, h in enumerate(hist):
        p, rev = (hist[i - 1] if i else None), h["revenue"]
        out.append({
            "growth": _div(rev, p["revenue"]) - 1 if p and p["revenue"] else None,
            "ebitda_margin": _div(h["ebitda"], rev),
            "oi_pct": _div(h["other_income"], rev),
            "dep_pct": _div(h["dep"], p["net_block"]) if p else None,
            "int_rate": _div(h["interest"], p["borrowings"]) if p else None,
            "tax_rate": _div(h["tax"], h["pbt"]),
            "mi_pct": _div(h["pat"] - (h["pbt"] - h["tax"]), h["pbt"] - h["tax"]),
            "payout": _div(h["dividend"], h["pat"]),
            "capex_pct": _div(h["capex"], rev) if p else None,
            "dso": _div(h["receivables"] * 365, rev),
            "dio": _div(h["inventory"] * 365, rev),
            "oca_pct": _div(h["other_ca"], rev),
            "ol_pct": _div(h["other_liab"], rev),
            "debt_change": h["borrowings"] - p["borrowings"] if p else None,
        })
    return out


def _ros(pairs, default=0.0):
    """Ratio of sums over (numerator, denominator) pairs, skipping zero denominators."""
    pairs = [(n, d) for n, d in pairs if d]
    den = sum(d for _, d in pairs)
    return sum(n for n, _ in pairs) / den if den > 0 else default


def default_assumptions(hist, years=3, exclude=(), labels=None):
    """Weighted (ratio-of-sums) averages over the last `years` reported years; growth is the plain CAGR over
    the last `years`. Borrowings held flat. Years in `exclude` (labels like "FY2020", matched against
    `labels`) are skipped and the window reaches further back instead, except for growth: no one-off flag is
    about revenue, and dropping a year from a growth window skews it (a dip year's rebound stays in)."""
    keep = [i for i in range(len(hist)) if labels is None or labels[i] not in exclude]
    if len(keep) < 2:
        raise ValueError("Keep at least two reported years in the defaults.")
    r = ratios(hist)
    w = [hist[i] for i in keep[-years:]]
    pw = [(hist[i - 1], hist[i]) for i in keep if i][-years:]  # (prev, cur); prev may be excluded: its closing balances are fine
    per_rev = lambda f: _ros((f(h), h["revenue"]) for h in w)  # noqa: E731
    oi = [r[i]["oi_pct"] for i in keep[-years:] if r[i]["oi_pct"] is not None]
    gp = [(hist[i - 1], hist[i]) for i in range(1, len(hist))][-years:]  # every year: growth ignores exclusions
    pos = all(p["revenue"] > 0 and h["revenue"] > 0 for p, h in gp)
    return {
        # the product telescopes to the plain CAGR
        "growth": math.prod(h["revenue"] / p["revenue"] for p, h in gp) ** (1 / len(gp)) - 1 if gp and pos else 0.0,
        "ebitda_margin": per_rev(lambda h: h["ebitda"]),
        # ponytail: Export folds exceptional items into Other Income; median drops a single one-off year
        "oi_pct": max(statistics.median(oi), 0.0) if oi else 0.0,
        "dep_pct": _ros((h["dep"], p["net_block"]) for p, h in pw),
        "int_rate": _ros((h["interest"], p["borrowings"]) for p, h in pw),
        # ponytail: loss years make raw tax ratios meaningless
        "tax_rate": min(max(_ros(((h["tax"], h["pbt"]) for h in w), 0.25), 0.0), 0.5),
        "payout": min(max(_ros((h["dividend"], h["pat"]) for h in w), 0.0), 1.0),
        # ponytail: clamp, loss years make the ratio flip sign
        "mi_pct": min(max(_ros((h["pat"] - (h["pbt"] - h["tax"]), h["pbt"] - h["tax"]) for h in w), -0.5), 0.5),
        # ponytail: capex comes from the net block change, so acquisitions show up as capex; median skips a merger year
        "capex_pct": statistics.median([h["capex"] / h["revenue"] for _, h in pw if h["revenue"]] or [0.0]),
        "dso": per_rev(lambda h: h["receivables"] * 365),
        "dio": per_rev(lambda h: h["inventory"] * 365),
        "oca_pct": per_rev(lambda h: h["other_ca"]),
        "ol_pct": per_rev(lambda h: h["other_liab"]),
        "debt_change": 0.0,
    }


# (ratios() key, words for the sentence, unit, floor). The floor is the smallest gap from typical worth a flag,
# so a very steady metric (TCS tax 22-26%) can't flag a 2 pp wobble just because its spread is tiny.
ONEOFF = (("oi_pct", "other income", " of revenue", 0.02), ("tax_rate", "tax rate", "", 0.10),
          ("capex_pct", "capex", " of revenue", 0.05), ("ebitda_margin", "EBITDA margin", "", 0.05))


def _pct(v):
    s = f"{v:.1%}"
    return "0.0%" if s == "-0.0%" else s


def detect_oneoffs(hist, labels, min_years=4):
    """Years where a metric is more than 2 sigma from the company's own median: [{year, metric, value, typical,
    note}]. sigma = 1.4826 x MAD, so the odd years themselves don't widen the band. A metric needs `min_years`
    values; tax rate skips loss years (a rate on a loss means nothing)."""
    r, out = ratios(hist), []
    for key, what, unit, floor in ONEOFF:
        pts = [(labels[i], x[key]) for i, x in enumerate(r)
               if x[key] is not None and (key != "tax_rate" or hist[i]["pbt"] > 0)]
        if len(pts) < min_years:
            continue
        typical = statistics.median(v for _, v in pts)
        band = max(2 * 1.4826 * statistics.median(abs(v - typical) for _, v in pts), floor)
        # ponytail: 25% anchors the Indian new-regime tax rate; a year nearer it than the median is the normal one
        # (a tax holiday ending, pre-IPO disallowances). Old-regime (34.9%) firms may leave a low year unflagged.
        out += [{"year": y, "metric": key, "value": v, "typical": typical,
                 "note": f"{y} {what} was {_pct(v)}{unit}, typically {_pct(typical)}"}
                for y, v in pts if abs(v - typical) > band
                and (key != "tax_rate" or abs(v - 0.25) >= abs(typical - 0.25))]
    return sorted(out, key=lambda o: labels.index(o["year"]))


def expand(assumptions, n):
    """{key: {"start", "end"}} -> {key: [n floats]}. end None = flat; otherwise a straight line from start
    (first projected year) to end (last projected year). A bare float is treated as flat."""
    out = {}
    for k, v in assumptions.items():
        s, e = (v, None) if isinstance(v, (int, float)) else (v["start"], v.get("end"))
        # ponytail: with one projected year there is no path to walk, so start wins
        out[k] = [s if e is None or n < 2 else s + (e - s) * t / (n - 1) for t in range(n)]
    return out


def project(hist, a, n=5):
    """Mirrors the Excel formulas in to_excel(); keep both in sync (test_model.py checks this).
    a[key] is a float (every year) or a list of n per-year values (see expand())."""
    out, p = [], hist[-1]
    for t in range(n):
        y = {k: v[t] if isinstance(v, list) else v for k, v in a.items()}  # this year's inputs
        c = {}
        c["revenue"] = p["revenue"] * (1 + y["growth"])
        c["ebitda"] = c["revenue"] * y["ebitda_margin"]
        c["other_income"] = c["revenue"] * y["oi_pct"]
        c["dep"] = p["net_block"] * y["dep_pct"]
        c["interest"] = p["borrowings"] * y["int_rate"]
        c["pbt"] = c["ebitda"] + c["other_income"] - c["dep"] - c["interest"]
        c["tax"] = max(0.0, c["pbt"] * y["tax_rate"])
        # ponytail: minority share / associates flow through cash and reserves; no separate minority-interest liability
        c["pat"] = (c["pbt"] - c["tax"]) * (1 + y["mi_pct"])
        c["dividend"] = max(0.0, c["pat"] * y["payout"])
        c["share_cap"] = p["share_cap"]
        c["reserves"] = p["reserves"] + c["pat"] - c["dividend"]
        planned = max(0.0, p["borrowings"] + y["debt_change"])
        c["other_liab"] = c["revenue"] * y["ol_pct"]
        c["capex"] = c["revenue"] * y["capex_pct"]
        c["net_block"] = p["net_block"] + c["capex"] - c["dep"]
        c["cwip"], c["investments"] = p["cwip"], p["investments"]
        c["receivables"] = c["revenue"] * y["dso"] / 365
        c["inventory"] = c["revenue"] * y["dio"] / 365
        c["other_ca"] = c["revenue"] * y["oca_pct"]
        non_cash = sum(c[k] for k in ("net_block", "cwip", "investments", "receivables", "inventory", "other_ca"))
        # revolver: borrow whatever keeps cash >= 0. Interest runs on opening debt, so no circularity.
        # ponytail: never repaid automatically; lower 'Borrowings change' to pay it down
        c["revolver"] = max(0.0, non_cash - (c["share_cap"] + c["reserves"] + planned + c["other_liab"]))
        c["borrowings"] = planned + c["revolver"]
        c["total_liab"] = c["share_cap"] + c["reserves"] + c["borrowings"] + c["other_liab"]
        c["cash"] = c["total_liab"] - non_cash  # balancing item
        c["total_assets"] = non_cash + c["cash"]
        c["cfo"] = (c["pat"] + c["dep"] - sum(c[k] - p[k] for k in ("receivables", "inventory", "other_ca"))
                    + c["other_liab"] - p["other_liab"])
        c["cfi"] = -c["capex"] - (c["cwip"] - p["cwip"]) - (c["investments"] - p["investments"])
        c["cff"] = c["borrowings"] - p["borrowings"] + c["share_cap"] - p["share_cap"] - c["dividend"]
        c["net_cf"] = c["cfo"] + c["cfi"] + c["cff"]
        c["fcf"] = c["cfo"] - c["capex"]
        # FCFF for the DCF: operating EBIT only; other income's cash and investments join in the equity bridge.
        # ponytail: a loss year's EBIT gets a tax credit at the full rate; fine while the value rests on profit years
        c["ebit"] = c["ebitda"] - c["dep"]
        c["nopat"] = c["ebit"] * (1 - y["tax_rate"])
        c["nwc"] = _nwc(c)
        c["fcff"] = c["nopat"] + c["dep"] - c["capex"] - (c["nwc"] - _nwc(p))
        c["chk_bs"] = c["total_assets"] - c["total_liab"]
        c["chk_cash"] = p["cash"] + c["net_cf"] - c["cash"]
        c.update(returns(c, p))
        out.append(c)
        p = c
    return out


def _nwc(r):
    return r["receivables"] + r["inventory"] + r["other_ca"] - r["other_liab"]


# The model document's "valuation" inputs. kd None = the base scenario's first-year interest rate;
# price / shares None = the export's market data. Same inputs for all three scenarios.
VALUATION = {"rf": 0.065, "erp": 0.07, "beta": 1.0, "kd": None, "g": 0.05, "mid_year": True,
             "wacc_override": None, "price": None, "shares": None}
MIN_SPREAD = 0.005  # WACC must beat terminal growth by 0.5 pp, or the Gordon value explodes
GRID_WACC = (-0.02, -0.01, 0.0, 0.01, 0.02)  # sensitivity grid steps around WACC (rows) and growth (columns)
GRID_G = (-0.01, -0.005, 0.0, 0.005, 0.01)
# second grid: shifts added to every projected year of revenue growth (rows) and EBITDA margin (columns)
GRID_GROWTH = (-0.04, -0.02, 0.0, 0.02, 0.04)
GRID_MARGIN = (-0.02, -0.01, 0.0, 0.01, 0.02)
IMPLIED_RANGE = (-0.30, 0.80)  # reverse DCF: flat revenue growth searched between these


def _dcf(fcff, period, w, g):
    """PV of the explicit years and of a Gordon terminal value; None when w doesn't clear g (or isn't positive).
    The terminal value takes the final year's discount factor: with mid-year flows that is the consistent one."""
    if not (w > 0 and w - g >= MIN_SPREAD):
        return None
    df = [(1 + w) ** -p for p in period]
    pv = [f * d for f, d in zip(fcff, df)]
    tv = fcff[-1] * (1 + g) / (w - g)
    return {"df": df, "pv": pv, "pv_sum": sum(pv), "tv": tv, "pv_tv": tv * df[-1], "ev": sum(pv) + tv * df[-1]}


def valuation(projs, hist, val, base, market, inputs=None):
    """DCF (free cash flow to firm) of each scenario, discounted from the last reported year end.
    projs: {scenario: project() rows}; val: VALUATION-shaped inputs; base: the base scenario's per-year inputs
    (expand()), for the default cost of debt and the WACC tax rate; market: the company's market data.
    inputs: {scenario: expand()} adds "grid_gm" per scenario (re-runs project() 25 times each) and
    "implied_growth" (reverse DCF, about 50 more runs each). "multiples": P/E, EV/EBITDA and P/B at each reported
    year end; per scenario at today's price and at its value per share (see _multiples()).
    Mirrors the Valuation sheet in to_excel()."""
    v, last = {**VALUATION, **(val or {})}, hist[-1]
    market = market or {}
    price = _pos(v["price"] if v["price"] is not None else market.get("price"))
    shares = _pos(v["shares"] if v["shares"] is not None else market.get("shares"))
    kd = base["int_rate"][0] if v["kd"] is None else v["kd"]
    tax = base["tax_rate"][0]
    ke, kd_at = v["rf"] + v["beta"] * v["erp"], kd * (1 - tax)
    # ponytail: no share price -> book equity weights the WACC; a negative book counts as zero
    e = price * shares if price and shares else max(0.0, last["share_cap"] + last["reserves"])
    d = last["borrowings"]
    we = e / (e + d) if e + d > 0 else 1.0
    wacc = v["wacc_override"] if v["wacc_override"] is not None else we * ke + (1 - we) * kd_at
    g, n = v["g"], len(next(iter(projs.values())))
    period = [t + 1 - (0.5 if v["mid_year"] else 0) for t in range(n)]
    bridge = -last["borrowings"] + last["cash"] + last["investments"]
    error = None
    if wacc <= 0:
        error = f"WACC is {_pct(wacc)}; it must be above zero."
    elif wacc - g < MIN_SPREAD:
        error = (f"WACC ({_pct(wacc)}) must be at least 0.5 pp above terminal growth ({_pct(g)}). "
                 "Lower the growth or raise the WACC.")
    per_share = lambda ev: (ev + bridge) / shares if ev is not None and shares else None  # noqa: E731
    out = {}
    for s, rows in projs.items():
        fcff = [r["fcff"] for r in rows]
        x = _dcf(fcff, period, wacc, g) or dict.fromkeys(("df", "pv", "pv_sum", "tv", "pv_tv", "ev"))
        ps = per_share(x["ev"])
        out[s] = {**x, "fcff": fcff, "equity": None if x["ev"] is None else x["ev"] + bridge, "per_share": ps,
                  "upside": ps / price - 1 if ps is not None and price else None,
                  "tv_share": x["pv_tv"] / x["ev"] if x["ev"] and x["ev"] > 0 else None,
                  "grid": [[per_share((_dcf(fcff, period, wacc + dw, g + dg) or {}).get("ev")) for dg in GRID_G]
                           for dw in GRID_WACC]}
        if inputs:
            out[s]["grid_gm"] = [[_shifted(hist, inputs[s], dgr, dm, period, wacc, g, per_share) for dm in GRID_MARGIN]
                                 for dgr in GRID_GROWTH]
            out[s]["implied_growth"] = _implied(hist, inputs[s], period, wacc, g, per_share, price)
        # multiples at today's price and at this value per share, on the last reported and first projected year
        out[s]["multiples"] = {f"{k}_{t}": _multiples(p * shares if p is not None and shares else None, -bridge, r)
                               for k, p in (("price", price), ("value", ps))
                               for t, r in (("last", last), ("next", rows[0]))}
    return {"inputs": v, "price": price, "shares": shares, "ke": ke, "kd": kd, "tax": tax, "kd_after_tax": kd_at,
            "e": e, "d": d, "we": we, "wacc": wacc, "g": g, "period": period, "error": error,
            "borrowings": last["borrowings"], "cash": last["cash"], "investments": last["investments"],
            "multiples": _hist_multiples(hist, market, shares),
            "steps": {"wacc": GRID_WACC, "g": GRID_G, "growth": GRID_GROWTH, "margin": GRID_MARGIN,
                      "implied": IMPLIED_RANGE}, "scenarios": out}


MULTIPLES = ("pe", "ev_ebitda", "pb")
MULTIPLE_LABELS = (("pe", "P/E (market cap / net profit)"),
                   ("ev_ebitda", "EV/EBITDA (EV = market cap + borrowings - cash - investments)"),
                   ("pb", "P/B (market cap / book equity)"))


def _multiples(mcap, ev_net, r):
    """P/E, EV/EBITDA, P/B of a market cap against year r's net profit, EBITDA and book equity (share capital +
    reserves). ev_net: borrowings - cash - investments. None without a positive market cap (a negative DCF value
    has no meaningful multiple) or when a denominator is <= 0."""
    if mcap is None or mcap <= 0:
        return dict.fromkeys(MULTIPLES)
    book = r["share_cap"] + r["reserves"]
    return {"pe": mcap / r["pat"] if r["pat"] > 0 else None,
            "ev_ebitda": (mcap + ev_net) / r["ebitda"] if r["ebitda"] > 0 else None,
            "pb": mcap / book if book > 0 else None}


def _hist_multiples(hist, market, shares):
    """Multiples at each reported year end's price, plus the median, min and max of each across the years.
    Mirrored by the MULTIPLES rows of the Valuation sheet."""
    years, ph, sh = [], market.get("price_hist") or [], market.get("shares_hist") or []
    for i, h in enumerate(hist):
        p, s = (_pos(x[i]) if i < len(x) else None for x in (ph, sh))
        # ponytail: a year without Export's adjusted share count uses today's count (typed or from the export)
        s = s or shares
        years.append(_multiples(p * s if p and s else None, h["borrowings"] - h["cash"] - h["investments"], h))
    out = {"hist": {k: [y[k] for y in years] for k in MULTIPLES}}
    for name, f in (("median", statistics.median), ("min", min), ("max", max)):
        out[name] = {k: f(xs) if (xs := [x for x in out["hist"][k] if x is not None]) else None for k in MULTIPLES}
    return out


def _shifted(hist, a, dgr, dm, period, wacc, g, per_share):
    """Value per share with growth and EBITDA margin moved by dgr / dm in every projected year."""
    a = {**a, "growth": [x + dgr for x in a["growth"]], "ebitda_margin": [x + dm for x in a["ebitda_margin"]]}
    fcff = [r["fcff"] for r in project(hist, a, len(period))]
    v = per_share((_dcf(fcff, period, wacc, g) or {}).get("ev"))
    return v if v is not None and math.isfinite(v) else None


def _implied(hist, a, period, wacc, g, per_share, price):
    """Reverse DCF: the flat revenue growth (every projected year, other drivers as they are) at which value per
    share equals the price. None without a price or per-share value, or when no growth in IMPLIED_RANGE gets there."""
    def gap(x):
        v = per_share((_dcf([r["fcff"] for r in project(hist, {**a, "growth": x}, len(period))], period, wacc, g)
                       or {}).get("ev"))
        return v - price if v is not None and math.isfinite(v) else None
    if not price or gap(0.0) is None:
        return None
    # ponytail: value isn't always monotonic in growth (heavy capex makes growth burn cash), so scan 5 pp steps for
    # sign changes and bisect the one nearest the scenario's own average growth; a root inside one step can be missed
    lo, hi = IMPLIED_RANGE
    xs = [lo + i * 0.05 for i in range(round((hi - lo) / 0.05) + 1)]
    ys = [gap(x) for x in xs]
    pairs = [(xs[i], xs[i + 1], ys[i]) for i in range(len(xs) - 1)
             if ys[i] is not None and ys[i + 1] is not None and (ys[i] == 0 or ys[i] * ys[i + 1] < 0)]
    if not pairs:
        return xs[-1] if ys[-1] == 0 else None
    mean = sum(a["growth"]) / len(a["growth"])
    lo, hi, ylo = min(pairs, key=lambda p: abs((p[0] + p[1]) / 2 - mean))
    while hi - lo > 1e-10:
        mid = (lo + hi) / 2
        ym = gap(mid)
        if ylo * ym <= 0:
            hi = mid
        else:
            lo, ylo = mid, ym
    return (lo + hi) / 2


def projected_dates(co, n):
    last = co["dates"][-1]
    return [last.replace(year=y, day=min(last.day, calendar.monthrange(y, last.month)[1]))
            for y in range(last.year + 1, last.year + n + 1)]


# ---------- Excel export (live formulas) ----------

RAW = {"revenue", "other_income", "dep", "interest", "pbt", "tax", "pat", "dividend", "share_cap", "reserves",
       "borrowings", "other_liab", "net_block", "cwip", "investments", "receivables", "inventory", "other_ca",
       "cash", "cfo", "cfi", "cff"}


def _returns_formulas(x, has_prev):
    """Excel twin of returns(): blank ("") where the denominator is <= ~0 (1e-6)."""
    avg = lambda f: f"(({f(0)})+({f(1)}))/2" if has_prev else f"({f(0)})"  # noqa: E731
    eq = lambda p: f'{x("share_cap", p)}+{x("reserves", p)}'  # noqa: E731
    pos = lambda num, den: f'=IFERROR(IF(({den})>1E-6,({num})/({den}),""),"")'  # noqa: E731
    ebit = f'{x("pbt")}+{x("interest")}'
    return {
        "roe": pos(x("pat"), avg(eq)),
        "roce": pos(ebit, avg(lambda p: f'{eq(p)}+{x("borrowings", p)}')),
        "asset_turnover": pos(x("revenue"), avg(lambda p: x("total_assets", p))),
        "nd_ebitda": pos(f'{x("borrowings")}-{x("cash")}-{x("investments")}', x("ebitda")),
        "int_cover": pos(ebit, x("interest")),
    }


def _hist_formula(key, x, has_prev):
    """Formula for a historical column. x(key, prev=False) -> cell ref."""
    def ratio(num, den):
        return f'=IFERROR({num}/{den},"")'
    needs_prev = {"growth", "dep_pct", "int_rate", "capex_pct", "debt_change", "capex", "fcf"}
    if key in needs_prev and not has_prev:
        return None
    return {
        "growth": f'=IFERROR({x("revenue")}/{x("revenue", 1)}-1,"")',
        "ebitda_margin": ratio(x("ebitda"), x("revenue")),
        "oi_pct": ratio(x("other_income"), x("revenue")),
        "dep_pct": ratio(x("dep"), x("net_block", 1)),
        "int_rate": ratio(x("interest"), x("borrowings", 1)),
        "tax_rate": ratio(x("tax"), x("pbt")),
        "payout": ratio(x("dividend"), x("pat")),
        "mi_pct": f'=IFERROR({x("pat")}/({x("pbt")}-{x("tax")})-1,"")',
        "capex_pct": ratio(x("capex"), x("revenue")),
        "dso": ratio(f'{x("receivables")}*365', x("revenue")),
        "dio": ratio(f'{x("inventory")}*365', x("revenue")),
        "oca_pct": ratio(x("other_ca"), x("revenue")),
        "ol_pct": ratio(x("other_liab"), x("revenue")),
        "debt_change": f'={x("borrowings")}-{x("borrowings", 1)}',
        "ebitda": f'={x("pbt")}+{x("interest")}+{x("dep")}-{x("other_income")}',
        "total_liab": f'=SUM({x("share_cap")}:{x("other_liab")})',
        "total_assets": f'=SUM({x("net_block")}:{x("cash")})',
        "net_cf": f'={x("cfo")}+{x("cfi")}+{x("cff")}',
        "capex": f'={x("net_block")}-{x("net_block", 1)}+{x("cwip")}-{x("cwip", 1)}+{x("dep")}',
        "fcf": f'={x("cfo")}-{x("capex")}',
        "chk_bs": f'=ROUND({x("total_assets")}-{x("total_liab")},2)',
        **_returns_formulas(x, has_prev),
    }.get(key)


def _proj_formula(key, x):
    d = lambda k: f'({x(k)}-{x(k, 1)})'  # noqa: E731
    return {
        "revenue": f'={x("revenue", 1)}*(1+{x("growth")})',
        "ebitda": f'={x("revenue")}*{x("ebitda_margin")}',
        "other_income": f'={x("revenue")}*{x("oi_pct")}',
        "dep": f'={x("net_block", 1)}*{x("dep_pct")}',
        "interest": f'={x("borrowings", 1)}*{x("int_rate")}',
        "pbt": f'={x("ebitda")}+{x("other_income")}-{x("dep")}-{x("interest")}',
        "tax": f'=MAX(0,{x("pbt")}*{x("tax_rate")})',
        "pat": f'=({x("pbt")}-{x("tax")})*(1+{x("mi_pct")})',
        "dividend": f'=MAX(0,{x("pat")}*{x("payout")})',
        "share_cap": f'={x("share_cap", 1)}',
        "reserves": f'={x("reserves", 1)}+{x("pat")}-{x("dividend")}',
        "borrowings": f'=MAX(0,{x("borrowings", 1)}+{x("debt_change")})+{x("revolver")}',
        "revolver": (f'=MAX(0,SUM({x("net_block")}:{x("other_ca")})-({x("share_cap")}+{x("reserves")}'
                     f'+MAX(0,{x("borrowings", 1)}+{x("debt_change")})+{x("other_liab")}))'),
        "other_liab": f'={x("revenue")}*{x("ol_pct")}',
        "total_liab": f'=SUM({x("share_cap")}:{x("other_liab")})',
        "net_block": f'={x("net_block", 1)}+{x("capex")}-{x("dep")}',
        "cwip": f'={x("cwip", 1)}',
        "investments": f'={x("investments", 1)}',
        "receivables": f'={x("revenue")}*{x("dso")}/365',
        "inventory": f'={x("revenue")}*{x("dio")}/365',
        "other_ca": f'={x("revenue")}*{x("oca_pct")}',
        "cash": f'={x("total_liab")}-SUM({x("net_block")}:{x("other_ca")})',
        "total_assets": f'=SUM({x("net_block")}:{x("cash")})',
        "cfo": f'={x("pat")}+{x("dep")}-{d("receivables")}-{d("inventory")}-{d("other_ca")}+{d("other_liab")}',
        "cfi": f'=-{x("capex")}-{d("cwip")}-{d("investments")}',
        "cff": f'={d("borrowings")}+{d("share_cap")}-{x("dividend")}',
        "net_cf": f'={x("cfo")}+{x("cfi")}+{x("cff")}',
        "capex": f'={x("revenue")}*{x("capex_pct")}',
        "fcf": f'={x("cfo")}-{x("capex")}',
        "ebit": f'={x("ebitda")}-{x("dep")}',
        "nopat": f'={x("ebit")}*(1-{x("tax_rate")})',
        "nwc": f'={x("receivables")}+{x("inventory")}+{x("other_ca")}-{x("other_liab")}',
        "fcff": (f'={x("nopat")}+{x("dep")}-{x("capex")}-({x("nwc")}-({x("receivables", 1)}+{x("inventory", 1)}'
                 f'+{x("other_ca", 1)}-{x("other_liab", 1)}))'),
        "chk_bs": f'=ROUND({x("total_assets")}-{x("total_liab")},2)',
        "chk_cash": f'=ROUND({x("cash", 1)}+{x("net_cf")}-{x("cash")},2)',
        **_returns_formulas(x, True),
    }[key]


def _scenario_sheet(wb, scenarios, n, years, formats, head_fill):
    """'Scenarios' sheet: one block of blue per-year input cells per scenario. Returns src(scenario, key, j) -> ref."""
    sc = wb.create_sheet("Scenarios")
    sc["A1"] = "Per-year inputs for each scenario. The Model sheet uses the one picked in its cell B3."
    sc["A1"].font = Font(italic=True, color="808080")
    sc.cell(3, 1, "Assumption").font = Font(bold=True)
    for j, y in enumerate(years):
        sc.cell(3, 2 + j, y).font = Font(bold=True)
    rows, r = {}, 4
    for s in SCENARIOS:
        for j in range(n + 1):
            sc.cell(r, 1 + j).fill = head_fill
        sc.cell(r, 1, s.upper()).font = Font(bold=True)
        inputs = expand(scenarios[s], n)
        for key, label, kind in DRIVERS:
            r += 1
            rows[s, key] = r
            sc.cell(r, 1, label)
            for j in range(n):
                c = sc.cell(r, 2 + j, inputs[key][j])
                c.number_format, c.font = formats[kind], Font(color="0000FF")
        r += 2
    sc.column_dimensions["A"].width = 46
    for j in range(n):
        sc.column_dimensions[get_column_letter(2 + j)].width = 11
    sc.freeze_panes = "B4"
    return lambda s, key, j: f"Scenarios!{get_column_letter(2 + j)}{rows[s, key]}"


def _valuation_sheet(wb, co, n, val, src, at, years, formats, head_fill, gm, implied):
    """'Valuation' sheet: the DCF of whichever scenario Model!B3 picks. Mirrors valuation().
    at(key, j) -> Model sheet ref for column j (0 = first reported year); gm: {scenario: grid_gm} values;
    implied: {scenario: implied_growth}."""
    v, m, nh = {**VALUATION, **(val or {})}, co.get("market") or {}, len(co["hist"])
    price = _pos(v["price"] if v["price"] is not None else m.get("price"))
    shares = _pos(v["shares"] if v["shares"] is not None else m.get("shares"))
    vs = wb.create_sheet("Valuation")
    vs["A1"] = "DCF of free cash flow to firm, for the scenario picked in Model!B3"
    vs["A1"].font = Font(bold=True, size=14)
    vs["A2"] = (f"Discounted from the {labels(co['dates'])[-1]} year end. Rs crore; value per share in Rs. "
                "Blue = input, green = from the Scenarios sheet (base, first projected year).")
    vs["A2"].font = Font(italic=True, color="808080")
    blue, green = Font(color="0000FF"), Font(color="008000")
    hist = lambda k: f"Model!{at(k, nh - 1)}"  # noqa: E731
    r, ref = 3, {}

    def put(key, label, value, fmt, font=None):
        nonlocal r
        r += 1
        ref[key] = f"$B${r}"
        vs.cell(r, 1, label)
        c = vs.cell(r, 2, value)
        c.number_format, c.font = fmt, font or Font()
        return c

    def head(title):
        nonlocal r
        r += 2
        for j in range(max(n, nh, 7) + 1):
            vs.cell(r, 1 + j).fill = head_fill
        vs.cell(r, 1, title).font = Font(bold=True)

    pct, num, rs = formats["pct"], formats["num"], "#,##0.00;(#,##0.00);-"
    r -= 1
    head("INPUTS")
    put("rf", "Risk-free rate (10-yr G-sec)", v["rf"], pct, blue)
    put("erp", "Equity risk premium", v["erp"], pct, blue)
    put("beta", "Beta", v["beta"], "0.00", blue)
    put("kd", "Cost of debt, pre-tax", f"={src('base', 'int_rate', 0)}" if v["kd"] is None else v["kd"], pct,
        green if v["kd"] is None else blue)
    put("tax", "Tax rate", f"={src('base', 'tax_rate', 0)}", pct, green)
    put("g", "Terminal growth", v["g"], pct, blue)
    put("mid", "Mid-year discounting (1 = yes, 0 = year end)", 1 if v["mid_year"] else 0, "0", blue)
    put("override", "WACC override (blank = build-up below)", v["wacc_override"], pct, blue)
    put("price", "Share price (Rs)", price, rs, blue)
    put("shares", "Shares (crore)", shares, rs, blue)

    head("WACC BUILD-UP")
    put("ke", "Cost of equity = risk-free + beta x premium", f"={ref['rf']}+{ref['beta']}*{ref['erp']}", pct)
    put("kd_at", "Cost of debt after tax", f"={ref['kd']}*(1-{ref['tax']})", pct)
    put("e", "Equity (market cap; book equity if no price)",
        f"=IF(AND(ISNUMBER({ref['price']}),ISNUMBER({ref['shares']})),{ref['price']}*{ref['shares']},"
        f"MAX(0,{hist('share_cap')}+{hist('reserves')}))", num)
    put("d", "Debt (borrowings)", f"={hist('borrowings')}", num)
    put("we", "Equity weight", f"=IF({ref['e']}+{ref['d']}>0,{ref['e']}/({ref['e']}+{ref['d']}),1)", pct)
    put("wd", "Debt weight", f"=1-{ref['we']}", pct)
    put("wacc", "WACC", f"=IF(ISNUMBER({ref['override']}),{ref['override']},"
                        f"{ref['we']}*{ref['ke']}+{ref['wd']}*{ref['kd_at']})", pct, Font(bold=True))
    ok = f"AND({ref['wacc']}>0,{ref['wacc']}-{ref['g']}>={MIN_SPREAD})"
    put("check", "", f'=IF({ok},"","WACC must be above zero and at least 0.5 pp above terminal growth")',
        "General", Font(bold=True, color="C00000"))

    head("EXPLICIT YEARS")
    for j, y in enumerate(years):
        vs.cell(r, 2 + j, y).font = Font(bold=True)
    rows = {}
    for key, label, fmt, f in (
        ("fcff", "Free cash flow to firm", num, lambda j: f"=Model!{at('fcff', nh + j)}"),
        ("period", "Discount period (years)", "0.0", lambda j: f"={j + 1}-IF({ref['mid']}=1,0.5,0)"),
        ("df", "Discount factor", "0.0000", lambda j: f'=IF({ok},1/(1+{ref["wacc"]})^{col(j)}{rows["period"]},"")'),
        ("pv", "Present value", num, lambda j: f'=IF({ok},{col(j)}{rows["fcff"]}*{col(j)}{rows["df"]},"")'),
    ):
        r += 1
        rows[key] = r
        vs.cell(r, 1, label)
        for j in range(n):
            c = vs.cell(r, 2 + j, f(j))
            c.number_format = fmt
    span = lambda key: f"$B${rows[key]}:${col(n - 1)}${rows[key]}"  # noqa: E731
    lastf, lastp, lastdf = (f"${col(n - 1)}${rows[k]}" for k in ("fcff", "period", "df"))

    head("ENTERPRISE VALUE TO VALUE PER SHARE")
    put("pv_sum", "PV of explicit years", f'=IF({ok},SUM({span("pv")}),"")', num)
    put("tv", "Terminal value (Gordon growth on final-year FCFF)",
        f'=IF({ok},{lastf}*(1+{ref["g"]})/({ref["wacc"]}-{ref["g"]}),"")', num)
    put("pv_tv", "PV of terminal value", f'=IF({ok},{ref["tv"]}*{lastdf},"")', num)
    put("ev", "Enterprise value", f'=IF({ok},{ref["pv_sum"]}+{ref["pv_tv"]},"")', num, Font(bold=True))
    put("borrowings", "Less borrowings", f"={hist('borrowings')}", num)
    put("cash", "Plus cash & bank", f"={hist('cash')}", num)
    put("investments", "Plus investments", f"={hist('investments')}", num)
    put("equity", "Equity value",
        f'=IF({ok},{ref["ev"]}-{ref["borrowings"]}+{ref["cash"]}+{ref["investments"]},"")', num, Font(bold=True))
    put("per_share", "Value per share (Rs)", f'=IFERROR(IF({ok},{ref["equity"]}/{ref["shares"]},""),"")', rs,
        Font(bold=True))
    put("upside", "Upside vs share price",
        f'=IFERROR(IF(ISNUMBER({ref["per_share"]}),{ref["per_share"]}/{ref["price"]}-1,""),"")', pct)
    put("tv_share", "Terminal value share of EV", f'=IFERROR(IF({ref["ev"]}>0,{ref["pv_tv"]}/{ref["ev"]},""),"")', pct)
    # ponytail: the reverse DCF is a search over whole projections, so like the second grid it ships as values
    x = ['""' if implied[s] is None else repr(implied[s]) for s in SCENARIOS]
    put("implied", "Revenue growth implied by share price", f"=CHOOSE(Model!$B$3,{','.join(x)})", pct)
    vs.cell(r, 3, "Flat every projected year, other inputs as set; value at export (re-run in the app)").font = Font(
        italic=True, color="808080")

    head("VALUE PER SHARE (Rs): WACC (rows) x TERMINAL GROWTH (columns)")
    top = r
    for i, dg in enumerate(GRID_G):
        c = vs.cell(top, 2 + i, f"={ref['g']}{dg:+}")
        c.number_format, c.font = pct, Font(bold=True)
    for k, dw in enumerate(GRID_WACC):
        r += 1
        c = vs.cell(r, 1, f"={ref['wacc']}{dw:+}")
        c.number_format, c.font = pct, Font(bold=True)
        for i in range(len(GRID_G)):
            w, g = f"$A{r}", f"{col(i)}${top}"
            vs.cell(r, 2 + i, (
                f'=IF(AND({w}>0,{w}-{g}>={MIN_SPREAD}),IFERROR((SUMPRODUCT({span("fcff")},1/(1+{w})^{span("period")})'
                f'+{lastf}*(1+{g})/({w}-{g})/(1+{w})^{lastp}-{ref["borrowings"]}+{ref["cash"]}+{ref["investments"]})'
                f'/{ref["shares"]},""),"")')).number_format = rs

    # ponytail: growth x margin needs a re-run of the whole projection per cell, so it ships as values
    # (one set per scenario, picked by the selector); editing inputs in Excel doesn't move it
    head("VALUE PER SHARE (Rs): REVENUE GROWTH SHIFT (rows) x EBITDA MARGIN SHIFT (columns)")
    vs.cell(r + 1, 1, "Values at export (re-run in the app). Shifts apply to every projected year.").font = Font(
        italic=True, color="808080")
    r += 1
    top = r
    for i, dm in enumerate(GRID_MARGIN):
        vs.cell(top, 2 + i, f"{dm * 100:+g} pp").font = Font(bold=True)
    for k, dgr in enumerate(GRID_GROWTH):
        r += 1
        vs.cell(r, 1, f"{dgr * 100:+g} pp").font = Font(bold=True)
        for i in range(len(GRID_MARGIN)):
            x = ['""' if gm[s][k][i] is None else repr(gm[s][k][i]) for s in SCENARIOS]
            vs.cell(r, 2 + i, f"=CHOOSE(Model!$B$3,{','.join(x)})").number_format = rs

    # multiples: every reported year at its year-end price, then today's price and the DCF value against the last
    # reported year and the first projected one (the selector's scenario). Mirrors _hist_multiples() / _multiples().
    head("MULTIPLES AT EACH REPORTED YEAR END")
    hl = labels(co["dates"])
    for j, y in enumerate(hl):
        vs.cell(r, 2 + j, y).font = Font(bold=True)
    hr, ph, sh, xf = {}, m.get("price_hist") or [], m.get("shares_hist") or [], '0.0"x";-0.0"x"'
    model_at = lambda k, j: f"Model!{at(k, j)}"  # noqa: E731

    def mult(cap, net, k, j):
        """P/E, EV/EBITDA, P/B formulas of market cap ref `cap` against Model column j; net = borrowings - cash
        - investments ("" when cap is blank or <= 0, or a denominator is <= 0)."""
        x = lambda key: model_at(key, j)  # noqa: E731
        book = f'{x("share_cap")}+{x("reserves")}'
        num, den = {"pe": (cap, x("pat")), "ev_ebitda": (f"({cap}+{net})", x("ebitda")), "pb": (cap, book)}[k]
        return f'=IFERROR(IF(AND(ISNUMBER({cap}),{cap}>0,{den}>0),{num}/({den}),""),"")'

    for key, label, fmt, f in (
        ("price", "Year-end share price (Rs)", rs, lambda j, c: _pos(ph[j]) if j < len(ph) else None),
        ("shares", "Shares (crore; today's if not reported)", rs,
         lambda j, c: (_pos(sh[j]) if j < len(sh) else None) or f'=IF(ISNUMBER({ref["shares"]}),{ref["shares"]},"")'),
        ("cap", "Market cap", num, lambda j, c: f'=IF(AND(ISNUMBER({c}{hr["price"]}),ISNUMBER({c}{hr["shares"]})),'
                                                f'{c}{hr["price"]}*{c}{hr["shares"]},"")'),
        *((k, label, xf, lambda j, c, k=k: mult(f"{c}{hr['cap']}", f"{model_at('borrowings', j)}-"
                                                    f"{model_at('cash', j)}-{model_at('investments', j)}", k, j))
          for k, label in MULTIPLE_LABELS),
    ):
        r += 1
        hr[key] = r
        vs.cell(r, 1, label)
        for j in range(nh):
            c = vs.cell(r, 2 + j, f(j, get_column_letter(2 + j)))
            c.number_format = fmt
            if key in ("price", "shares") and not str(c.value).startswith("="):
                c.font = blue

    nxt, last_y = years[0], hl[-1]
    head("MULTIPLES CROSS-CHECK: HISTORY vs TODAY'S PRICE vs DCF VALUE (scenario in Model!B3)")
    heads = ("History median", "History low", "History high", f"Price, {last_y}", f"Price, {nxt}",
             f"Value, {last_y}", f"Value, {nxt}")
    for i, h in enumerate(heads):
        vs.cell(r, 2 + i, h).font = Font(bold=True)
    net = f"{ref['borrowings']}-{ref['cash']}-{ref['investments']}"
    cap_p = f'IF(AND(ISNUMBER({ref["price"]}),ISNUMBER({ref["shares"]})),{ref["price"]}*{ref["shares"]},"")'
    cap_v = f'IFERROR({ref["per_share"]}*{ref["shares"]},"")'
    for k, label in MULTIPLE_LABELS:
        r += 1
        span_h = f"$B${hr[k]}:${get_column_letter(1 + nh)}${hr[k]}"
        vs.cell(r, 1, label.split(" (")[0])
        cells = [f'=IF(COUNT({span_h})=0,"",{fn}({span_h}))' for fn in ("MEDIAN", "MIN", "MAX")]
        cells += [mult(cap, net, k, j) for cap in (cap_p, cap_v) for j in (nh - 1, nh)]
        for i, x in enumerate(cells):
            vs.cell(r, 2 + i, x).number_format = xf

    vs.column_dimensions["A"].width = 50
    for j in range(max(n, len(GRID_G), nh, len(heads))):
        vs.column_dimensions[get_column_letter(2 + j)].width = 12


def col(j):
    """Valuation sheet column for explicit year j (B = first projected year)."""
    return get_column_letter(2 + j)


def to_excel(co, scenarios, n=5, active="base", val=None):
    """Workbook bytes: historicals as values, projections as live formulas, inputs in blue.
    scenarios: {"base"|"bull"|"bear": {key: {"start", "end"}}}. Each scenario's per-year inputs (from expand())
    sit on the Scenarios sheet; the Model sheet's driver cells pick one with CHOOSE on the selector in B3.
    val: VALUATION-shaped inputs for the Valuation sheet (None = defaults)."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Model"
    ws["A1"] = co["name"]
    ws["A1"].data_type = "s"  # a name starting with '=' must not become a live formula
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = ("Rs crore. Source: Export.in export. Blue = input (B3 and the Scenarios sheet), "
                "green = picked from the Scenarios sheet, black = formula.")
    ws["A2"].font = Font(italic=True, color="808080")
    ws["A3"] = "Scenario (1 = base, 2 = bull, 3 = bear)"
    ws["B3"] = SCENARIOS.index(active) + 1
    ws["B3"].font = Font(bold=True, color="0000FF")
    ws["C3"] = '=CHOOSE(B3,"Base","Bull","Bear")'
    pick = DataValidation(type="whole", operator="between", formula1="1", formula2="3", showErrorMessage=True,
                          error="Enter 1 (base), 2 (bull) or 3 (bear).")
    ws.add_data_validation(pick)
    pick.add("B3")

    top = 4  # header row
    rows = {key: top + 1 + i for i, (_, key, _) in enumerate(LAYOUT) if key}
    nh = len(co["hist"])
    headers = labels(co["dates"]) + [fy(d, True) for d in projected_dates(co, n)]
    bold, totals = Font(bold=True), {"total_liab", "total_assets", "pat", "fcf", "fcff"}
    head_fill = PatternFill("solid", fgColor="DDE4EE")
    formats = {"pct": "0.0%", "days": "0", "num": "#,##0.0;(#,##0.0);-", "chk": "#,##0.00;(#,##0.00);-",
               "x": '0.0"x";-0.0"x"'}
    drivers = {k for k, _, _ in DRIVERS}
    src = _scenario_sheet(wb, scenarios, n, headers[nh:], formats, head_fill)

    ws.cell(top, 1, "Rs crore").font = bold
    for j, h in enumerate(headers):
        cell = ws.cell(top, 2 + j, h)
        cell.font = bold
        if j >= nh:
            cell.fill = PatternFill("solid", fgColor="FFF2CC")

    for i, (label, key, kind) in enumerate(LAYOUT):
        r = top + 1 + i
        ws.cell(r, 1, label)
        if kind == "head":
            for j in range(len(headers) + 1):
                ws.cell(r, 1 + j).fill = head_fill
            ws.cell(r, 1).font = bold
        if not key:
            continue
        for j in range(len(headers)):
            col, prev = get_column_letter(2 + j), get_column_letter(1 + j)
            x = lambda k, p=0, col=col, prev=prev: f"{prev if p else col}{rows[k]}"  # noqa: E731
            cell = ws.cell(r, 2 + j)
            if j < nh:
                h = co["hist"][j]  # missing cash-flow lines stay blank instead of 0-based formulas
                cell.value = h.get(key) if key in RAW or h.get(key, 0) is None else _hist_formula(key, x, j > 0)
            else:
                cell.value = (f"=CHOOSE($B$3,{','.join(src(s, key, j - nh) for s in SCENARIOS)})"
                              if key in drivers else _proj_formula(key, x))
            cell.number_format = formats[kind]
            cell.font = Font(bold=key in totals, color="008000" if j >= nh and key in drivers else None)
        ws.cell(r, 1).font = Font(bold=key in totals)

    ws.column_dimensions["A"].width = 34
    for j in range(len(headers)):
        ws.column_dimensions[get_column_letter(2 + j)].width = 11
    ws.freeze_panes = ws.cell(top + 1, 2)
    ex = {s: expand(scenarios[s], n) for s in SCENARIOS}
    v = valuation({s: project(co["hist"], ex[s], n) for s in SCENARIOS}, co["hist"], val, ex["base"],
                  co.get("market"), inputs=ex)
    _valuation_sheet(wb, co, n, val, src, lambda k, j: f"{get_column_letter(2 + j)}{rows[k]}", headers[nh:],
                     formats, head_fill, {s: x["grid_gm"] for s, x in v["scenarios"].items()},
                     {s: x["implied_growth"] for s, x in v["scenarios"].items()})
    cash_proj = f"{get_column_letter(2 + nh)}{rows['cash']}:{get_column_letter(1 + len(headers))}{rows['cash']}"
    ws.conditional_formatting.add(cash_proj, CellIsRule(operator="lessThan", formula=["0"],
                                                        font=Font(color="C00000", bold=True),
                                                        fill=PatternFill("solid", fgColor="FDE2E1")))

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
