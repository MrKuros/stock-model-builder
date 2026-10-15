"""Export.in Excel export -> three-statement projection model (all figures in Rs crore)."""
import calendar
import io
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
    return {"name": str(name), "dates": dates, "hist": hist}


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


# ---------- ratios & projection ----------

def _div(a, b):
    return a / b if b else None


def returns(c, p=None):
    """Return ratios for year c; p = previous year (None: averages fall back to closing balances).
    Blank (None) when the denominator is <= 0: a ratio on negative equity or EBITDA means nothing.
    EBIT = PBT + interest. Mirrored by _returns_formulas()."""
    avg = lambda f: (f(c) + f(p)) / 2 if p else f(c)  # noqa: E731
    eq = lambda r: r["share_cap"] + r["reserves"]  # noqa: E731
    pos = lambda num, den: num / den if den > 0 else None  # noqa: E731
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


def default_assumptions(hist, years=3):
    """Weighted (ratio-of-sums) averages over the last `years`; growth is CAGR. Borrowings held flat."""
    w, pw = hist[-years:], list(zip(hist, hist[1:]))[-years:]  # pw: (prev, cur)
    per_rev = lambda f: _ros((f(h), h["revenue"]) for h in w)  # noqa: E731
    rev = [h["revenue"] for h in hist]
    k = min(years, len(rev) - 1)
    oi = [x["oi_pct"] for x in ratios(hist)[-years:] if x["oi_pct"] is not None]
    return {
        "growth": (rev[-1] / rev[-1 - k]) ** (1 / k) - 1 if k > 0 and rev[-1] > 0 and rev[-1 - k] > 0 else 0.0,
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
        c["chk_bs"] = c["total_assets"] - c["total_liab"]
        c["chk_cash"] = p["cash"] + c["net_cf"] - c["cash"]
        c.update(returns(c, p))
        out.append(c)
        p = c
    return out


def projected_dates(co, n):
    last = co["dates"][-1]
    return [last.replace(year=y, day=min(last.day, calendar.monthrange(y, last.month)[1]))
            for y in range(last.year + 1, last.year + n + 1)]


# ---------- Excel export (live formulas) ----------

RAW = {"revenue", "other_income", "dep", "interest", "pbt", "tax", "pat", "dividend", "share_cap", "reserves",
       "borrowings", "other_liab", "net_block", "cwip", "investments", "receivables", "inventory", "other_ca",
       "cash", "cfo", "cfi", "cff"}


def _returns_formulas(x, has_prev):
    """Excel twin of returns(): blank ("") where the denominator is <= 0."""
    avg = lambda f: f"(({f(0)})+({f(1)}))/2" if has_prev else f"({f(0)})"  # noqa: E731
    eq = lambda p: f'{x("share_cap", p)}+{x("reserves", p)}'  # noqa: E731
    pos = lambda num, den: f'=IFERROR(IF(({den})>0,({num})/({den}),""),"")'  # noqa: E731
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


def to_excel(co, scenarios, n=5, active="base"):
    """Workbook bytes: historicals as values, projections as live formulas, inputs in blue.
    scenarios: {"base"|"bull"|"bear": {key: {"start", "end"}}}. Each scenario's per-year inputs (from expand())
    sit on the Scenarios sheet; the Model sheet's driver cells pick one with CHOOSE on the selector in B3.
    A single assumption set {key: ...} is used for all three."""
    if "base" not in scenarios:
        scenarios = dict.fromkeys(SCENARIOS, scenarios)
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
    headers = [fy(d) for d in co["dates"]] + [fy(d, True) for d in projected_dates(co, n)]
    bold, totals = Font(bold=True), {"total_liab", "total_assets", "pat", "fcf"}
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
    cash_proj = f"{get_column_letter(2 + nh)}{rows['cash']}:{get_column_letter(1 + len(headers))}{rows['cash']}"
    ws.conditional_formatting.add(cash_proj, CellIsRule(operator="lessThan", formula=["0"],
                                                        font=Font(color="C00000", bold=True),
                                                        fill=PatternFill("solid", fgColor="FDE2E1")))

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
