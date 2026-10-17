"""Run: uv run python test_model.py  (Excel formula check needs LibreOffice `soffice` on PATH)."""
import calendar
import contextlib
import io
import json
import os
import re
import shutil
import statistics
import subprocess
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

import openpyxl
from pydantic import ValidationError

import model


def fake_screener(path, years=10, quarters=True):
    """Synthetic file in Screener.in 'Data Sheet' layout with internally consistent numbers. The Quarters block is
    laid out like the real export: ten quarter ends, the last three after the final year; quarters=False leaves only
    its heading, as in an export without quarterly data (Milky Mist)."""
    dates = [datetime(2016 + i, 3, 31) for i in range(years)]
    pl = {k: [] for k in ("Sales", "Raw Material Cost", "Other Income", "Depreciation", "Interest",
                          "Profit before tax", "Tax", "Net profit", "Dividend Amount")}
    bs = {k: [] for k in ("Equity Share Capital", "Reserves", "Borrowings", "Other Liabilities", "Total",
                          "Net Block", "Capital Work in Progress", "Investments", "Other Assets", "Total#2",
                          "Receivables", "Inventory", "Cash & Bank")}
    for i in range(years):
        rev = 1000 * 1.12 ** i
        dep, interest, oi = 40 + 3 * i, 20.0, 0.02 * rev
        pbt = 0.2 * rev + oi - dep - interest
        tax = 0.25 * pbt
        for k, v in zip(pl, (rev, 0.5 * rev, oi, dep, interest, pbt, tax, pbt - tax, 0.3 * (pbt - tax))):
            pl[k].append(round(v, 2))
        liab = (50, 400 + 80 * i, 200, 0.15 * rev)
        total = sum(liab)
        nb, cwip, inv = 500 + 30 * i, 20, 60
        rec, stock = 0.12 * rev, 0.08 * rev
        other_assets = total - nb - cwip - inv
        cash = other_assets - rec - stock - 0.03 * rev
        for k, v in zip(bs, (*liab, total, nb, cwip, inv, other_assets, total, rec, stock, cash)):
            bs[k].append(round(v, 2))

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Data Sheet"
    ws.append(["COMPANY NAME", "Test Industries Ltd"])
    ws.append([])
    ws.append(["META"])  # like the real export: Number of shares is a formula with no cached value
    for row in (["Number of shares", None], ["Face Value", 10], ["Current Price", 1600], ["Market Capitalization", 8000]):
        ws.append(row)
    ws.append(["PROFIT & LOSS"])
    ws.append(["Report Date", *dates])
    for k, v in pl.items():
        ws.append([k, *v])
    ws.append(["Quarters"])
    if quarters:
        for row in _quarter_rows(dates[-1]):
            ws.append(row)
    ws.append(["BALANCE SHEET"])
    ws.append(["Report Date", *dates])
    for k, v in bs.items():
        ws.append([k.split("#")[0], *v])
    ws.append(["CASH FLOW:"])
    ws.append(["Report Date", *dates])
    ws.append(["Cash from Operating Activity", *[100.0] * years])
    ws.append(["PRICE:", *[round(500 * 1.1 ** i, 2) for i in range(years - 1)], None])  # last year blank
    ws.append(["DERIVED:"])
    ws.append(["Adjusted Equity Shares in Cr", *[5.0] * years])
    wb.save(path)


def _quarter_rows(last_fy):
    """Ten quarters ending three after last_fy, growing ~12% a year; the first quarter has no Other Income and the
    last no Tax (Screener leaves gaps), so TTM tax must come out blank in Python and Excel alike."""
    ends = [divmod(last_fy.year * 12 + last_fy.month - 1 + 3 * (k - 6), 12) for k in range(10)]
    ends = [datetime(y, m + 1, calendar.monthrange(y, m + 1)[1]) for y, m in ends]  # Sep 2023 .. Dec 2025
    sales = [round(612 * 1.12 ** (k / 4), 2) for k in range(10)]  # the four to the year end sum to about its Sales
    exp = [round(0.8 * x, 2) for x in sales]
    oi = [None, *[round(0.02 * x, 2) for x in sales[1:]]]
    pbt = [round(x - e + (o or 0) - 12 - 5, 2) for x, e, o in zip(sales, exp, oi)]
    tax = [*[round(0.25 * x, 2) for x in pbt[:-1]], None]
    net = [round(0.75 * x, 2) for x in pbt]
    return [["Report Date", *ends], ["Sales", *sales], ["Expenses", *exp], ["Other Income", *oi],
            ["Depreciation", *[12] * 10], ["Interest", *[5] * 10], ["Profit before tax", *pbt], ["Tax", *tax],
            ["Net profit", *net], ["Operating Profit", *[round(x - e, 2) for x, e in zip(sales, exp)]]]


def recalc(xlsx, outdir):
    """LibreOffice headless round-trip so formula cells get computed values."""
    subprocess.run(["soffice", "--headless", "--convert-to", "xlsx", "--outdir", str(outdir), str(xlsx)],
                   check=True, capture_output=True, timeout=120)
    return openpyxl.load_workbook(Path(outdir) / Path(xlsx).name, data_only=True)["Model"]


def main():
    tmp = Path(tempfile.mkdtemp())
    src = tmp / "screener.xlsx"
    fake_screener(src)

    co = model.parse_screener(src)
    assert co["name"] == "Test Industries Ltd"
    assert len(co["hist"]) == 10
    assert co["hist"][0]["revenue"] == 1000.0, "quarterly Sales leaked into annual data"
    assert model.data_checks(co) == [], model.data_checks(co)
    assert co["hist"][1]["cfi"] is None and co["hist"][1]["net_cf"] is None, "missing CF rows must not be 0"
    quarters_check(tmp, co)
    xbrl_check(co)
    review_rules_check(co)
    pins_check(co)
    m = co["market"]
    assert m["price"] == 1600 and m["shares"] == 5.0 and m["shares_hist"] == [5.0] * 10, m
    assert m["price_hist"][0] == 500 and m["price_hist"][-1] is None and len(m["price_hist"]) == 10, m
    # no market cap: shares fall back to the latest adjusted count; no META/PRICE/DERIVED at all: all null, no error
    p = tmp / "no_mcap.xlsx"
    fake_screener(p)
    _edit_rows(p, lambda label, row: label == "Market Capitalization" and setattr(row[1], "value", None))
    assert model.parse_screener(p)["market"]["shares"] == 5.0
    _edit_rows(p, lambda label, row: label in ("META", "Current Price", "PRICE:", "Adjusted Equity Shares in Cr")
               and [setattr(c, "value", None) for c in row])
    assert model.parse_screener(p)["market"] == {"price": None, "shares": None, "price_hist": [None] * 10,
                                                  "shares_hist": [None] * 10}

    a = model.default_assumptions(co["hist"])
    assert abs(a["growth"] - 0.12) < 1e-3 and abs(a["ebitda_margin"] - 0.2) < 1e-3, a
    assert abs(a["tax_rate"] - 0.25) < 1e-3 and abs(a["dso"] - 0.12 * 365) < 0.1, a

    # defaults: CAGR not mean of YoY, ratio-of-sums not mean of ratios, median other income
    h = [dict(co["hist"][-1]) for _ in range(4)]
    for x, r, b, i in zip(h, (100, 50, 100, 100), (2, 2, 500, 500), (0, 15, 45, 45)):
        x.update(revenue=r, borrowings=b, interest=i, other_income=0.02 * r)
    h[-1]["other_income"] = -900  # one-off write-down
    d = model.default_assumptions(h)
    assert abs(d["growth"]) < 1e-9 and d["int_rate"] < 0.3 and d["oi_pct"] == 0.02, d

    # one-off years: robust 2-sigma vs the company's own median, floors, >= 4 values, loss years skip tax
    labels = [model.fy(d) for d in co["dates"]]
    assert model.detect_oneoffs(co["hist"], labels) == [], "steady synthetic history must flag nothing"
    odd = [dict(x) for x in co["hist"]]
    odd[4]["other_income"] += 0.08 * odd[4]["revenue"]  # FY2020 exceptional gain, booked in other income
    odd[4]["pbt"] += 0.08 * odd[4]["revenue"]
    odd[7]["tax"] = 0.45 * odd[7]["pbt"]  # FY2023 tax spike
    odd[8]["tax"], odd[8]["pbt"] = 50.0, -10.0  # FY2024 loss year: no tax-rate flag
    odd[2]["tax"] = 0.27 * odd[2]["pbt"]  # 2 pp wobble on a steady rate: under the floor
    found = model.detect_oneoffs(odd, labels)
    assert [(o["year"], o["metric"]) for o in found] == [("FY2020", "oi_pct"), ("FY2023", "tax_rate")], found
    assert found[0]["note"] == "FY2020 other income was 10.0% of revenue, typically 2.0%", found[0]["note"]
    assert abs(found[1]["value"] - 0.45) < 1e-3 and abs(found[1]["typical"] - 0.25) < 1e-3, found[1]
    assert model.detect_oneoffs(odd[3:6], labels[3:6]) == [], "fewer than 4 years: flag nothing"
    # tax: a latest year near the 25% statutory rate is the normal one, not a one-off (Milky Mist: 57, 56, 48, 20%)
    mm = [dict(x, pbt=100.0, tax=t) for x, t in zip(co["hist"][-4:], (57.0, 56.0, 48.0, 20.0))]
    assert not [o for o in model.detect_oneoffs(mm, labels[-4:]) if o["metric"] == "tax_rate"], "near-statutory year"
    # excluding years: the window skips them and reaches back; nothing excluded = unchanged; growth ignores exclusions
    assert model.default_assumptions(odd, exclude=set(), labels=labels) == model.default_assumptions(odd)
    no_last = model.default_assumptions(odd, exclude={"FY2025"}, labels=labels)
    assert no_last == {**model.default_assumptions(odd[:-1]), "growth": no_last["growth"]}
    assert no_last["growth"] == model.default_assumptions(odd)["growth"]
    dip = [dict(x) for x in co["hist"]]
    dip[7]["revenue"] *= 0.55  # FY2023 dip year: excluding it must not keep the x2 rebound out of it
    assert abs(model.default_assumptions(dip, exclude={"FY2023"}, labels=labels)["growth"] - 0.12) < 1e-6
    # a year-end change (Mar 2019 then Dec 2019) gets unique labels, so excluding one year drops only that one
    moved = [*co["dates"][:4], datetime(2019, 12, 31), *co["dates"][5:]]
    ml = model.labels(moved)
    assert ml[3:5] == ["FY2019", "FY2019 Dec"] and len(set(ml)) == len(ml), ml
    assert model.default_assumptions(co["hist"], exclude={"FY2019"}, labels=ml) == model.default_assumptions(
        co["hist"][:3] + co["hist"][4:])
    ex = model.default_assumptions(odd, exclude={"FY2023", "FY2024"}, labels=labels)
    assert abs(ex["tax_rate"] - 0.25) < 1e-3 and abs(ex["growth"] - 0.12) < 1e-6, ex
    assert ex["dso"] == model._ros((odd[i]["receivables"] * 365, odd[i]["revenue"]) for i in (5, 6, 9)), ex
    assert model.default_assumptions(odd, labels=labels)["tax_rate"] > 0.3
    try:
        model.default_assumptions(odd, exclude=set(labels[1:]), labels=labels)
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "two" in str(e)

    for edit, msg in ((_bankify, "bank"), (_no_dimension, None), (_text_cell, "not a number")):
        p = tmp / f"{edit.__name__}.xlsx"
        fake_screener(p)
        edit(p)
        try:
            model.parse_screener(p)
            assert msg is None, f"{edit.__name__}: expected ValueError"
        except ValueError as e:
            assert msg and msg in str(e), (edit.__name__, e)
    try:
        model.parse_screener(io.BytesIO(b"not a zip"))
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "Export to Excel" in str(e)

    # return ratios: averages of opening and closing balances, first year on closing
    h0, h1 = co["hist"][0], co["hist"][1]
    eq = lambda h: h["share_cap"] + h["reserves"]  # noqa: E731
    assert abs(h0["roe"] - h0["pat"] / eq(h0)) < 1e-12
    assert abs(h1["roe"] - h1["pat"] / ((eq(h0) + eq(h1)) / 2)) < 1e-12
    assert abs(h1["roce"] - (h1["pbt"] + h1["interest"]) / ((eq(h0) + eq(h1) + 400) / 2)) < 1e-12
    assert abs(h1["asset_turnover"] - h1["revenue"] / ((h0["total_assets"] + h1["total_assets"]) / 2)) < 1e-12
    assert abs(h1["int_cover"] - (h1["pbt"] + 20) / 20) < 1e-12
    assert abs(h1["nd_ebitda"] - (200 - h1["cash"] - 60) / h1["ebitda"]) < 1e-12
    neg = model.returns(dict(h1, interest=0.0, ebitda=-1.0, reserves=-1000.0), h0)
    assert neg["int_cover"] is None and neg["nd_ebitda"] is None and neg["roe"] is None, neg

    assert abs(a["mi_pct"]) < 1e-3, a  # synthetic PAT = PBT - tax
    a["debt_change"] = 25.0
    a["mi_pct"] = -0.05  # exercise the minority path in the Excel parity check below
    a["capex_pct"] = 0.35  # heavy capex: forces the automatic shortfall borrowing

    # per-year paths: end None = flat, else a straight line from first to last projected year
    e = model.expand({"g": {"start": 0.1, "end": 0.02}, "f": {"start": 3.0, "end": None}, "x": 7.0}, 5)
    assert e["f"] == [3.0] * 5 and e["x"] == [7.0] * 5 and e["g"][0] == 0.1 and abs(e["g"][-1] - 0.02) < 1e-15, e
    assert abs(e["g"][2] - 0.06) < 1e-15 and model.expand({"g": {"start": 1, "end": 9}}, 1) == {"g": [1]}, e
    flat = model.expand({k: {"start": v, "end": None} for k, v in a.items()}, 5)
    assert model.project(co["hist"], flat, 5) == model.project(co["hist"], a, 5), "flat path must equal legacy floats"
    paths = {k: {"start": v, "end": None} for k, v in a.items()}
    paths.update(growth={"start": 0.18, "end": 0.04}, ebitda_margin={"start": 0.2, "end": 0.26},
                 capex_pct={"start": 0.35, "end": 0.08}, dso={"start": 30.0, "end": 75.0},
                 debt_change={"start": 25.0, "end": -60.0}, payout={"start": 0.1, "end": 0.5})
    ea = model.expand(paths, 5)
    proj = model.project(co["hist"], ea, n=5)
    assert proj[0]["revenue"] == co["hist"][-1]["revenue"] * 1.18
    assert abs(proj[-1]["revenue"] / proj[-2]["revenue"] - 1.04) < 1e-12, "last year must use the end value"
    for c in proj:
        assert abs(c["chk_bs"]) < 1e-6 and abs(c["chk_cash"]) < 1e-6, c
        assert c["cash"] >= -1e-9, c
    assert any(c["revolver"] > 0 for c in proj), "test should exercise the revolver"

    try:
        model.parse_screener(_blank(tmp))
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "Data Sheet" in str(e)

    # scenarios: bull/bear seeded like the UI (growth +/- 3 pp, EBITDA margin +/- 1.5 pp), bear also edited
    bump = lambda p, d: {"start": p["start"] + d, "end": None if p["end"] is None else p["end"] + d}  # noqa: E731
    seeded = {s: dict(paths, growth=bump(paths["growth"], sign * 0.03),
                      ebitda_margin=bump(paths["ebitda_margin"], sign * 0.015))
              for s, sign in (("base", 0), ("bull", 1), ("bear", -1))}
    seeded["bear"]["capex_pct"] = {"start": 0.12, "end": None}
    ex = {s: model.expand(seeded[s], 5) for s in model.SCENARIOS}
    projs = {s: model.project(co["hist"], ex[s], n=5) for s in model.SCENARIOS}
    assert projs["base"] == proj
    assert projs["bull"][-1]["revenue"] > proj[-1]["revenue"] > projs["bear"][-1]["revenue"]

    valuation_check(co, projs, ex)
    note_check(co, projs, ex)
    library_check(tmp / "models", co, seeded)
    upgrade_check(tmp, co, excel=bool(shutil.which("soffice")))

    if not shutil.which("soffice"):
        print("SKIP Excel formula check: soffice not found")
        return
    rows = {key: 5 + i for i, (_, key, _) in enumerate(model.LAYOUT) if key}
    for i, s in enumerate(model.SCENARIOS):  # export opens on the active scenario: selector = 1, 2, 3
        (tmp / s).mkdir()
        (tmp / s / "model.xlsx").write_bytes(model.to_excel(co, seeded, n=5, active=s))
        ws = recalc(tmp / s / "model.xlsx", tmp / s / "calc")
        assert ws["B3"].value == i + 1 and ws["C3"].value == s.title(), (ws["B3"].value, ws["C3"].value)
        for j, c in enumerate(projs[s]):  # incl. the per-year driver cells picked by CHOOSE
            _same(ws, rows, 2 + len(co["hist"]) + j, {**c, **{k: v[j] for k, v in ex[s].items()}}, (s, j))
        _same_valuation(ws.parent["Valuation"], model.valuation(projs, co["hist"], None, ex["base"], co["market"], ex), s)
        _same_quarters(ws.parent["Quarters"], co["quarters"])
    edge = {s: dict(p) for s, p in seeded.items()}
    edge["base"].update(int_rate={"start": 0.3, "end": None}, mi_pct={"start": -0.1, "end": None})
    edge["bear"]["capex_pct"] = {"start": 0.4, "end": None}
    ee = {s: model.expand(edge[s], 5) for s in model.SCENARIOS}
    ve = {"wacc_override": 0.055, "g": 0.05}  # exactly 0.5 pp, also on the grid's edges
    vedge = model.valuation({s: model.project(co["hist"], ee[s], 5) for s in model.SCENARIOS}, co["hist"], ve,
                            ee["base"], co["market"], ee)
    assert vedge["kd"] == vedge["ke"] and vedge["nci"] == 0.1 and vedge["scenarios"]["bear"]["error"], vedge["kd"]
    for i, s in enumerate(model.SCENARIOS):
        (tmp / f"edge-{s}").mkdir()
        (tmp / f"edge-{s}" / "model.xlsx").write_bytes(model.to_excel(co, edge, n=5, active=s, val=ve))
        wse = recalc(tmp / f"edge-{s}" / "model.xlsx", tmp / f"edge-{s}" / "calc")
        _same_valuation(wse.parent["Valuation"], vedge, s)
    dv = wse.parent["Valuation"].data_validations.dataValidation
    assert any("B" in str(d.sqref) and d.formula2 == "1" for d in dv), dv  # the mid-year cell takes 0 or 1 only
    for j, h in enumerate(co["hist"]):  # historical ratio formulas, incl. first year on closing balances
        _same(ws, rows, 2 + j, {k: h[k] for k in ("ebitda", *RETURNS)}, ("hist", j))
    # zero interest and negative EBITDA must come out blank in both
    zero = dict(a, int_rate=0.0, ebitda_margin=-0.05)
    proj0 = model.project(co["hist"], zero, n=2)
    assert all(c["int_cover"] is None and c["nd_ebitda"] is None for c in proj0), proj0
    (tmp / "zero").mkdir()
    # ... with no market data (book equity weights, no per-share value), typed cost of debt, year-end discounting
    bare = dict(co, market=None)
    # typed shares without a price: no upside or price multiples; the final FCFF is negative, so no value
    v0 = {"kd": 0.09, "mid_year": False, "rf": 0.07, "beta": 1.3, "g": 0.03, "shares": 5.0}
    (tmp / "zero" / "model.xlsx").write_bytes(model.to_excel(bare, dict.fromkeys(model.SCENARIOS, zero), n=2, val=v0))
    ws0 = recalc(tmp / "zero" / "model.xlsx", tmp / "calc0")
    for j, c in enumerate(proj0):
        _same(ws0, rows, 2 + len(co["hist"]) + j, c, ("zero", j))
    flat0 = model.expand({k: {"start": v, "end": None} for k, v in zero.items()}, 2)
    val0 = model.valuation(dict.fromkeys(model.SCENARIOS, proj0), co["hist"], v0, flat0, None,
                           dict.fromkeys(model.SCENARIOS, flat0))
    m0 = val0["scenarios"]["base"]["multiples"]
    assert val0["e"] == co["hist"][-1]["share_cap"] + co["hist"][-1]["reserves"] and val0["kd"] == 0.09, val0
    assert val0["scenarios"]["base"]["error"] and val0["scenarios"]["base"]["per_share"] is None, val0["scenarios"]
    assert {x for b in m0.values() for x in b.values()} == {None}, m0
    _same_valuation(ws0.parent["Valuation"], val0, "base")
    # debt faded to zero over 10 years: float residue (1e-14 cr) must read as no interest cover, in both
    payoff = {k: {"start": v, "end": None} for k, v in model.default_assumptions(co["hist"]).items()}
    payoff["debt_change"] = {"start": 0.0, "end": -50.0}
    ep = model.expand(payoff, 10)
    proj10 = model.project(co["hist"], ep, n=10)
    assert proj10[-1]["int_cover"] is None, proj10[-1]["int_cover"]
    (tmp / "payoff").mkdir()
    # ... with a WACC override too close to terminal growth: an error and blank values in both; typed price/shares
    v10 = {"wacc_override": 0.1, "g": 0.098, "price": 2000.0, "shares": 4.0}
    (tmp / "payoff" / "model.xlsx").write_bytes(
        model.to_excel(co, dict.fromkeys(model.SCENARIOS, payoff), n=10, val=v10))
    ws10 = recalc(tmp / "payoff" / "model.xlsx", tmp / "calc10")
    for j, c in enumerate(proj10):
        _same(ws10, rows, 2 + len(co["hist"]) + j, {**c, **{k: v[j] for k, v in ep.items()}}, ("payoff", j))
    val10 = model.valuation(dict.fromkeys(model.SCENARIOS, proj10), co["hist"], v10, ep, co["market"],
                            dict.fromkeys(model.SCENARIOS, ep))
    assert "0.5 pp" in val10["error"] and val10["scenarios"]["base"]["ev"] is None and val10["e"] == 8000, val10
    _same_valuation(ws10.parent["Valuation"], val10, "base")
    vs10 = ws10.parent["Valuation"]
    msg = vs10.cell(next(c.row for c in vs10["A"] if c.value == "WACC") + 1, 2).value  # the line under WACC
    assert msg.startswith("WACC must"), msg
    print("OK: parse, checks, projection, Excel formulas match Python")


def quarters_check(tmp, co):
    """Quarters block: real layout, gaps stay blank, TTM = last four consecutive quarters, none = no quarters."""
    q = co["quarters"]
    assert len(q["dates"]) == 10 and q["dates"][-1] == datetime(2025, 12, 31) and q["dates"][0] == datetime(2023, 9, 30)
    r = q["rows"]
    assert r["sales"][0] == 612.0 and r["other_income"][0] is None and r["tax"][-1] is None, r
    # operating profit: PBT + interest + depreciation - other income; Screener's row only when a line is missing
    assert abs(r["op_profit"][5] - (r["pbt"][5] + 5 + 12 - r["other_income"][5])) < 1e-9, r["op_profit"]
    assert r["op_profit"][0] == 122.4, r["op_profit"][0]  # Screener's Operating Profit row, other income missing
    t, prev = model.ttm(q), model.ttm(q, 4)
    assert t["end"] == datetime(2025, 12, 31) and prev["end"] == datetime(2024, 12, 31), (t, prev)
    assert t["values"]["sales"] == sum(r["sales"][-4:]) and t["values"]["tax"] is None, t
    assert prev["values"]["tax"] == sum(r["tax"][2:6]), prev
    assert model.ttm(q, 7) is None, "fewer than four quarters left: no TTM"
    gap = {"dates": q["dates"][:6] + q["dates"][7:], "rows": {k: v[:6] + v[7:] for k, v in r.items()}}
    assert model.ttm(gap) is None and model.ttm(gap, 3) is not None, "a missing quarter breaks the run of four"
    # the four quarters up to the last year end add up to about its annual Sales (the synthetic file is built so)
    assert abs(sum(r["sales"][3:7]) / co["hist"][-1]["revenue"] - 1) < 0.01
    p = tmp / "no_quarters.xlsx"
    fake_screener(p, quarters=False)
    bare = model.parse_screener(p)
    assert bare["quarters"] is None and bare["hist"] == co["hist"], "no quarters: annual data unchanged"
    assert "Quarters" not in openpyxl.load_workbook(io.BytesIO(model.to_excel(bare, _flat_scenarios(bare)))).sheetnames
    p = tmp / "quarter_text.xlsx"  # a text cell in a quarter blanks that quarter only
    fake_screener(p)
    _edit_rows(p, lambda label, row: label == "Expenses" and setattr(row[2], "value", "n/a"))
    assert model.parse_screener(p)["quarters"]["rows"]["expenses"][1] is None


def fake_xbrl(co, quarter=False, web=False, standalone=False, extra=""):
    """Hand-written NSE results XBRL for the synthetic company, laid out like the real files (in-bse-fin elements,
    rupees with decimals -7, OneD = the quarter, FourD = the year to date, OneI = the balance sheet date). A Q4
    filing (default) carries the last reported year; quarter=True the last Screener quarter. web=True drops the
    context definitions, as NSE's "_WEB" files do, and puts the year's cash flow under the quarter's context."""
    if quarter:
        i = len(co["quarters"]["dates"]) - 1
        end, r = co["quarters"]["dates"][i], {k: v[i] for k, v in co["quarters"]["rows"].items()}
        y = {"revenue": r["sales"], "other_income": r["other_income"], "dep": r["depreciation"],
             "interest": r["interest"], "pbt": r["pbt"], "tax": r["tax"] or 0.0, "pat": r["net_profit"]}
        start, ytd = datetime(end.year, end.month - 2, 1), datetime(end.year if end.month > 3 else end.year - 1, 4, 1)
    else:
        y = co["hist"][-1]
        end, start = co["dates"][-1], datetime(co["dates"][-1].year, 1, 1)
        ytd = datetime(end.year - 1, 4, 1)
    rs = lambda v: f"{v * 1e7:.2f}"  # noqa: E731
    ctx = lambda i, a, b, dim="": (  # noqa: E731
        f'<xbrli:context id="{i}"><xbrli:entity><xbrli:identifier scheme="http://www.nseindia.com/NSESymbol">TESTIND'
        f'</xbrli:identifier></xbrli:entity><xbrli:period>'
        + (f"<xbrli:instant>{b:%Y-%m-%d}</xbrli:instant>" if a is None else
           f"<xbrli:startDate>{a:%Y-%m-%d}</xbrli:startDate><xbrli:endDate>{b:%Y-%m-%d}</xbrli:endDate>")
        + f"</xbrli:period>{dim}</xbrli:context>")
    fact = lambda tag, c, v, unit="INR": (  # noqa: E731
        f'<in-bse-fin:{tag} contextRef="{c}" unitRef="{unit}" decimals="-7">{rs(v)}</in-bse-fin:{tag}>')
    head = "".join(f'<in-bse-fin:{t} contextRef="{c}">{v}</in-bse-fin:{t}>' for c, a in (("OneD", start), ("FourD", ytd))
                   for t, v in (("DateOfStartOfReportingPeriod", f"{a:%Y-%m-%d}"),
                                ("DateOfEndOfReportingPeriod", f"{end:%Y-%m-%d}"),
                                ("NatureOfReportStandaloneConsolidated", "Standalone" if standalone else "Consolidated")))
    pl = lambda c, k: "".join(fact(t, c, k * v) for t, v in (  # noqa: E731  k scales the quarter's share of the year
        ("RevenueFromOperations", y["revenue"]), ("OtherIncome", y["other_income"]),
        ("DepreciationDepletionAndAmortisationExpense", y["dep"]), ("FinanceCosts", y["interest"]),
        ("ProfitBeforeTax", y["pbt"]), ("TaxExpense", y["tax"]),
        ("ProfitLossForPeriodFromContinuingOperations", y["pbt"] - y["tax"]),
        ("ProfitLossForPeriod", y["pbt"] - y["tax"]), ("ProfitOrLossAttributableToOwnersOfParent", y["pat"])))
    seg = ctx("OneSegment01D", start, end, '<xbrli:scenario><xbrldi:explicitMember dimension="in-bse-fin:'
              'DescriptionOfReportableSegmentAxis">in-bse-fin:OneReportableSegment01Member</xbrldi:explicitMember>'
              '</xbrli:scenario>')
    contexts = "" if web else ctx("OneD", start, end) + ctx("FourD", ytd, end) + ctx("OneI", None, end) + seg
    cash = "" if quarter else (fact("CashFlowsFromUsedInOperatingActivities", "OneD" if web else "FourD", 321.5)
                               + fact("PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
                                      "OneD" if web else "FourD", 88.25))
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<xbrli:xbrl xmlns:in-bse-fin="http://www.bseindia.com/xbrl/fin/'
        '2020-03-31/in-bse-fin" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/'
        'xbrldi" xmlns:iso4217="http://www.xbrl.org/2003/iso4217">' + contexts
        + '<xbrli:unit id="INR"><xbrli:measure>iso4217:INR</xbrli:measure></xbrli:unit>'
        '<xbrli:unit id="INRLakhs"><xbrli:measure>iso4217:INR</xbrli:measure></xbrli:unit>'
        '<in-bse-fin:Symbol contextRef="OneD">TESTIND</in-bse-fin:Symbol>' + head
        + pl("OneD", 1.0 if quarter else 0.26) + pl("FourD", 3.0 if quarter else 1.0) + cash
        + fact("RevenueFromOperations", "OneSegment01D", 123.0)  # a segment: a breakdown, never a statement line
        + fact("TradeReceivablesCurrent", "OneI", co["hist"][-1]["receivables"])
        + fact("BorrowingsNoncurrent", "OneI", 150.0) + fact("BorrowingsCurrent", "OneI", 50.0)
        + fact("RoyaltyIncome", "OneD" if quarter else "FourD", 4.2) + extra + "</xbrli:xbrl>").encode()


def xbrl_check(co):
    """XBRL results filings: periods, units, contexts (defined or not), duplicates, unknown tags, ties, safety."""
    h = co["hist"][-1]
    for web in (False, True):  # contexts defined, and the _WEB style where they aren't
        f = model.parse_xbrl(fake_xbrl(co, web=web), company=co)
        assert (f["kind"], f["period_start"], f["period_end"]) == ("annual", "2024-04-01", "2025-03-31"), f
        assert f["company"] == "TESTIND" and f["consolidated"] is True, f
        fx = f["facts"]
        assert abs(fx["revenue"] - h["revenue"]) < 1e-6 and abs(fx["pat"] - h["pat"]) < 1e-6, fx  # rupees -> crore
        assert fx["cfo"] == 321.5 and fx["purchase_ppe"] == 88.25, "a Q4 filing's cash flow is the year's"
        assert fx["receivables"] == h["receivables"] and fx["borrowings"] == 200.0, fx
        assert f["unmapped"] == [{"tag": "RoyaltyIncome", "value": 4.2, "unit": "Rs crore", "context": "FourD"}], f["unmapped"]
        assert all(c["pass"] for c in f["checks"]), f["checks"]
        assert [c["name"] for c in f["checks"]] == ["PBT less tax = profit", "Revenue for FY2025 matches Screener",
                                                    "Net profit for FY2025 matches Screener"], f["checks"]
    # the quarter (not the nine months to date) of a Q3 filing, tied to Screener's quarter; no cash flow kept
    f = model.parse_xbrl(fake_xbrl(co, quarter=True), company=co)
    assert (f["kind"], f["period_start"], f["period_end"]) == ("quarter", "2025-10-01", "2025-12-31"), f
    assert abs(f["facts"]["revenue"] - co["quarters"]["rows"]["sales"][-1]) < 1e-6, f["facts"]
    assert [c["pass"] for c in f["checks"]] == [True, True, True] and "cfo" not in f["facts"], f["checks"]
    # approved mappings are applied by rules on the next parse
    f = model.parse_xbrl(fake_xbrl(co), mappings={"RoyaltyIncome": "royalty"})
    assert f["facts"]["royalty"] == 4.2 and f["unmapped"] == [], f
    assert all(c["name"] != "Ties to Screener" for c in f["checks"]), "no company: no tie checks"
    # a mismatch is reported, not blocked; a standalone filing says why it may differ
    mis = model.parse_xbrl(fake_xbrl(co, standalone=True, extra='<in-bse-fin:RevenueFromOperations contextRef="FourD" '
                           f'unitRef="INR" decimals="-7">{h["revenue"] * 1.03e7:.2f}</in-bse-fin:RevenueFromOperations>'),
                           company=co)
    rev = next(c for c in mis["checks"] if c["name"].startswith("Revenue"))
    assert mis["consolidated"] is False and rev["pass"] is True, "the first of two different values is kept"
    dup = next(c for c in mis["checks"] if c["name"] == "One value for revenue")
    assert dup["pass"] is False and "kept the first" in dup["detail"], mis["checks"]
    moved = dict(co, hist=[*co["hist"][:-1], dict(h, revenue=h["revenue"] / 1.03)])
    rev = next(c for c in model.parse_xbrl(fake_xbrl(co, standalone=True), company=moved)["checks"]
               if c["name"].startswith("Revenue"))
    assert rev["pass"] is False and "3.0% apart" in rev["detail"] and "standalone" in rev["detail"], rev
    # exact duplicates (the real files repeat facts) are fine; a year Screener doesn't have is a note
    same = model.parse_xbrl(fake_xbrl(co, extra='<in-bse-fin:TaxExpense contextRef="FourD" unitRef="INR" '
                                      f'decimals="-7">{h["tax"] * 1e7:.2f}</in-bse-fin:TaxExpense>'), company=co)
    assert all(c["pass"] for c in same["checks"]), same["checks"]
    later = dict(co, dates=co["dates"][:-1], hist=co["hist"][:-1])
    assert model.parse_xbrl(fake_xbrl(co), company=later)["checks"][-1]["pass"] is None
    # units by rules: a lakhs unit is divided by 100, a pure number is not money
    lakhs = model.parse_xbrl(fake_xbrl(co).replace(
        b'<in-bse-fin:TradeReceivablesCurrent contextRef="OneI" unitRef="INR"',
        b'<in-bse-fin:TradeReceivablesCurrent contextRef="OneI" unitRef="INRLakhs"'))
    assert abs(lakhs["facts"]["receivables"] - h["receivables"] * 1e5) < 1e-3, lakhs["facts"]["receivables"]
    # bad files: DTDs and entities are refused before parsing; not XML; XML that isn't XBRL
    bomb = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><x>&b;</x>'
    for bad, msg in ((bomb, "DTD"), (b"<?xml version='1.0'?><!doctype x SYSTEM 'file:///etc/passwd'><x/>", "DTD"),
                     ("<x/>".encode("utf-16"), "UTF-16"), (b"not xml", "well-formed"), (b"<html></html>", "XBRL")):
        try:
            model.parse_xbrl(bad)
        except ValueError as e:
            assert msg in str(e), (bad, e)
        else:
            raise AssertionError(bad)


# Outputs of the engine before 3.4 (commit 29e0cc6), default assumptions, base, 5 years. Screener-only models must
# reproduce them: TCS is on revenue (bit for bit); the synthetic company is on COGS, where inventory days now count on
# COGS, so its days default doubles (COGS is half of revenue) and the inventory it projects is the same.
PIN_KEYS = ("revenue", "pat", "inventory", "receivables", "other_liab", "borrowings", "cash", "net_block", "capex",
            "fcff", "interest")
PINS = {
    "synthetic": {
        "defaults": {"growth": 0.12000067516402613, "ebitda_margin": 0.20000080431973322, "oi_pct": 0.01999942302421856,
                     "dep_pct": 0.09014084507042254, "int_rate": 0.1, "tax_rate": 0.25000359934923766,
                     "payout": 0.29999520084465137, "mi_pct": -5.4560079532378e-17, "capex_pct": 0.037965072133637055,
                     "dso": 43.80017614602157, "dio": 29.200117430681047, "oca_pct": 0.029998444981849188,
                     "ol_pct": 0.1499989275736891, "debt_change": 0.0},
        "first": (3105.8514722838577, 445.407546891067, 248.46911702175962, 372.70367553263947, 465.874390045742, 200.0,
                  534.8128789046038, 818.5054244773941, 117.9138751816195, 338.69672889591345, 20.0),
        "last": (4887.1292052405015, 722.0047005385113, 390.9719087450235, 586.4578631175352, 733.0641397001308, 200.0,
                 1796.358714567698, 1119.131157568024, 185.54021280335996, 528.7618686285541, 20.0),
        "per_share": 1097.1241320193562, "wacc": 0.1335365765869531},
    "TCS": {
        "defaults": {"growth": 0.10072809184198905, "ebitda_margin": 0.27408899696100636, "oi_pct": 0.029257911805745815,
                     "dep_pct": 0.2135380938682481, "int_rate": 0.2073558882470824, "tax_rate": 0.24300193617671728,
                     "payout": 0.5474221233972694, "mi_pct": -0.003406819852750826, "capex_pct": 0.02544814438075979,
                     "dso": 68.65923920365962, "dio": 0.01795380130841401, "oca_pct": 0.21834773700835564,
                     "ol_pct": 0.18815027727341746, "debt_change": 0.0},
        "first": (180714.23593434223, 36750.75840037819, 8.889061604293238, 33993.703979513935, 34001.433598300275,
                  7795.0, 19970.81859959611, 21131.057696511387, 4598.84196771583, 28106.701728215114,
                  1616.3391488860073),
        "last": (265284.9222554354, 55636.92082412305, 13.048966532307247, 49902.08475139777, 49913.43167881716, 7795.0,
                 84063.65395172854, 25567.463455587153, 6751.009003594956, 44232.24769933669, 1616.3391488860073),
        "per_share": 1272.814030514745, "wacc": 0.13480481681094378},
}


def _pinned(co, pin, where):
    d = model.default_assumptions(co["hist"])
    ex = model.expand({k: {"start": v, "end": None} for k, v in d.items()}, 5)
    pr = model.project(co["hist"], ex, 5)
    v = model.valuation({"base": pr}, co["hist"], None, ex, co["market"])
    near = lambda a, b: abs(a - b) <= 1e-9 * max(1.0, abs(b))  # noqa: E731
    old = pin["defaults"]
    for k, want in old.items():
        got = d[k] * d["cogs_pct"] if k == "dio" and model.on_cogs(co["hist"]) else d[k]
        assert near(got, want), (where, k, got, want)  # on COGS: days x COGS share = the old days on revenue
    assert d["dpo"] == 0.0, (where, d["dpo"])
    for t, rows in (("first", pr[0]), ("last", pr[-1])):
        for k, want in zip(PIN_KEYS, pin[t]):
            assert near(rows[k], want), (where, t, k, rows[k], want)
        assert rows["payables"] == 0.0 and rows["lease"] == 0.0, (where, rows["payables"], rows["lease"])
    assert near(v["scenarios"]["base"]["per_share"], pin["per_share"]) and near(v["wacc"], pin["wacc"]), where


def pins_check(co):
    """Screener-only models give the numbers they gave before 3.4. Real exports: set REAL_EXPORTS to a folder with
    <NAME>/<NAME>.xlsx (TCS is pinned); skipped without it."""
    _pinned(co, PINS["synthetic"], "synthetic")
    assert model.on_cogs(co["hist"]) and model.upgrade(co)["hist"] == co["hist"], "no filings: history unchanged"
    real = os.environ.get("REAL_EXPORTS")
    tcs = Path(real or ".") / "TCS" / "TCS.xlsx"
    if real and tcs.exists():
        t = model.parse_screener(tcs)
        assert not model.on_cogs(t["hist"]), "TCS: Rs 14 cr of materials, days stay on revenue"
        _pinned(t, PINS["TCS"], "TCS")
    else:
        print("SKIP real-export pins: set REAL_EXPORTS to a folder holding TCS/TCS.xlsx")


def _filing(co, end_i=-1, extra=""):
    """An annual fake_xbrl for reported year end_i, read with ties against co, as the client stores it."""
    sub = dict(co, dates=co["dates"][:len(co["dates"]) + end_i + 1], hist=co["hist"][:len(co["hist"]) + end_i + 1])
    f = model.parse_xbrl(fake_xbrl(sub, extra=extra), company=co)
    return {"id": f"f{end_i}", "file": f"fy{sub['dates'][-1].year}.xml", **f}


def _fact(tag, v, c="OneI"):
    return f'<in-bse-fin:{tag} contextRef="{c}" unitRef="INR" decimals="-7">{v * 1e7:.2f}</in-bse-fin:{tag}>'


def review_rules_check(co):
    """Rules from the Phase 3 review: approved mappings never override a standard element, a negative purchase is a
    size, both lease-payment elements, zip / binary files, and the AI-output rules in ai.py (units as whole words and
    from table headings, quotes on word boundaries, the current-year column, the report's year, amounts that parse)."""
    import sys  # noqa: PLC0415
    import ai  # noqa: PLC0415

    std = b"<in-bse-fin:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"
    x = fake_xbrl(co).replace(std, _fact("CompanyCapexTag", 999.0, "FourD").encode() + std, 1)
    f = model.parse_xbrl(x, mappings={"CompanyCapexTag": "purchase_ppe"})
    assert f["facts"]["purchase_ppe"] == 88.25, "a mapped tag filed first must not beat the standard element"
    assert any(c["name"] == "One value for purchase_ppe" and c["pass"] is None for c in f["checks"]), f["checks"]
    x0 = x.replace(b">882500000.00</in-bse-fin:PurchaseOf", b">0.00</in-bse-fin:PurchaseOf")
    assert model.parse_xbrl(x0, mappings={"CompanyCapexTag": "purchase_ppe"})["facts"]["purchase_ppe"] == 999.0, \
        "a standard 0 still gives way to the approved mapping"
    neg = model.parse_xbrl(fake_xbrl(co).replace(b">882500000.00</in-bse-fin:PurchaseOf", b">-882500000.00</in-bse-fin:PurchaseOf"))
    assert neg["facts"]["purchase_ppe"] == 88.25 and any(c["name"] == "Sign of purchase_ppe" for c in neg["checks"]), neg
    old = {"id": "o", "file": "o.xml", "kind": "annual", "period_end": "2025-03-31", "consolidated": True,
           "facts": {**neg["facts"], "purchase_ppe": -88.25}}  # saved before the flip
    assert model.upgrade(co, [old])["hist"][-1]["capex"] == 88.25
    assert "purchase_ppe" in model.XBRL_NONNEG
    for a, b in ((632.0, 0.0), (0.0, 632.0)):
        e = (_fact("PaymentsOfFinanceLeaseLiabilitiesClassifiedAsFinancingActivities", a, "FourD")
             + _fact("PaymentsOfLeaseLiabilitiesClassifiedAsFinancingActivities", b, "FourD"))
        assert model.parse_xbrl(fake_xbrl(co, extra=e))["facts"]["lease_payments"] == 632.0
    for data, says in ((b"PK\x03\x04rest", "zip"), (b"%PDF-1.4\x00", "UTF-8")):
        try:
            model.parse_xbrl(data)
            raise AssertionError("expected ValueError")
        except ValueError as err:
            assert says in str(err) and "DTD" not in str(err), err
    assert model.mapping_checks({"unmapped": [{"value": 1}, {"tag": "Foo", "value": [1], "context": "c"}]}, "Foo",
                                "revenue")[0] is None, "damaged entries are skipped, not a crash"

    # ai.py rules on made-up pages [(reading order, layout)]
    end = datetime(2025, 3, 31).date()
    yr = "Statement for the year ended March 31, 2025"
    pg = lambda *lines: ("\n".join((yr, *lines)), "\n".join((yr, *lines)))  # noqa: E731
    capex = lambda amt, quote, unit="crore", pages=None: ai.note_checks("capex", {  # noqa: E731
        "unit": unit, "items": [{"label": "PPE", "amount": amt, "page": 1, "quote": quote}]}, pages, [1], end)
    fails = lambda r: {c["name"] for c in r[2] if c["pass"] is False}  # noqa: E731
    row = "Purchase of property, plant and equipment (21,234.56) (19,876.00)"
    crore = [pg("(Rs in crore)", row, "Proceeds from sale 45.10")] * 3
    # units: whole words and the table heading decide, not "credit" or "place"
    lakh_credit = [pg("(Rs in lakh)", row, "Trade receivables and other credit items")] * 3
    assert "Unit" in fails(capex("(21,234.56)", row, "crore", lakh_credit)), "' cr' of 'credit' isn't crore"
    in_place = [pg("(Rs in crore)", row, "right-of-use assets in place")] * 3
    assert "Unit" in fails(capex("(21,234.56)", row, "lakh", in_place)), "'lac' of 'place' isn't lakh"
    tonnes = [pg("(All amounts in Rs lakh)", row, "Capacity of 12 million tonnes")] * 3
    r = capex("(21,234.56)", row, "lakh", tonnes)
    assert fails(r) == set() and abs(r[1] - 212.3456) < 1e-9, r[2]
    # quotes cut inside a number aren't on the page
    for amt, quote in (("2123", "Purchase of property, plant and equipment (21,23"),
                       ("1,234.56", "1,234.56) (19,876.00) Proceeds from sale"), ("34.56", "34.56) (19,876.00) Proceeds from sale")):
        assert "Quotes are on their pages" in fails(capex(amt, quote, pages=crore)), quote
    assert fails(capex("(21,234.56)", "Purchase of property, plant and equipment (21,234.56", pages=crore)) == set()
    gw = [("Impairment of goodwill of Rs 500 crore in the year", "")] + [(yr, yr)] * 3
    q = ai.quote_checks({"page": 1, "quote": "the impairment of goodwill of Rs 5"}, gw, [1], end)
    assert {c["name"] for c in q if c["pass"] is False} == {"Quote is on the page"}, q
    # the previous year's column is rejected, also when the quote starts mid-row
    assert fails(capex("19,876.00", row, pages=crore)) == {"Current-year column"}
    assert fails(capex("(19,876.00)", "(19,876.00)  Proceeds from sale", pages=[pg("(Rs in crore)", row + "  Proceeds from sale")] * 3)) == {
        "Current-year column"}
    two = [pg("(Rs in crore)", "Exchange gain   (21)   (117)     Purchase of PPE   (2,719)   (2,538)")] * 3  # two columns
    assert fails(capex("(2,719)", "Purchase of PPE  (2,719)  (2,538)", pages=two)) == set()
    assert fails(capex("(2,538)", "Purchase of PPE  (2,719)  (2,538)", pages=two)) == {"Current-year column"}
    noted = "Purchase of PPE 4.1 (21,234.56) (19,876.00)"  # a note number before the amounts is skipped
    assert fails(capex("21,234.56", noted, pages=[pg("(Rs in crore)", noted)] * 3)) == set()
    # the report is for the year: named more often than the years either side
    fy21 = [("Year ended March 31, 2021 and March 31, 2020", "")] * 3 + [("March 31, 2021", "")] * 5
    assert ai.year_check(fy21, datetime(2021, 3, 31).date())["pass"] is True
    wrong = ai.year_check(fy21, datetime(2020, 3, 31).date())
    assert wrong["pass"] is False and "31 Mar 2021" in wrong["detail"], wrong
    assert ai.year_check(fy21, datetime(2022, 3, 31).date())["pass"] is False
    # amounts that don't parse to a finite number; deep nesting is "no JSON", not a crash
    assert all(ai.amount(v) is None for v in ("inf", "1e999", "nan", "(inf)", "-Infinity"))
    limit = sys.getrecursionlimit()
    sys.setrecursionlimit(300)
    try:
        ai.first_json("[" * 2000)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
    finally:
        sys.setrecursionlimit(limit)


def upgrade_check(tmp, co, excel):
    """3.4: annual filings add trade payables, lease liabilities and cash-flow capex to their year by rules; totals
    don't move; days run on COGS where it matters; Excel equals Python for selectors 1-3."""
    h24, h25 = co["hist"][-2], co["hist"][-1]
    f25 = _filing(co, -1, _fact("TradePayablesCurrent", 0.06 * h25["revenue"]) + _fact("LeaseLiabilitiesNoncurrent", 30.0))
    f24 = _filing(co, -2, _fact("TradePayablesCurrent", 0.05 * h24["revenue"]))
    quarter = {"id": "q", "file": "q.xml", **model.parse_xbrl(fake_xbrl(co, quarter=True), company=co)}
    off = dict(_filing(dict(co, hist=[*co["hist"][:-1], dict(h25, revenue=h25["revenue"] * 1.05)])), file="off.xml",
               consolidated=False)  # revenue 5% from Screener's: not used
    up = model.upgrade(co, [off, quarter, f24, f25])
    u24, u25 = up["hist"][-2], up["hist"][-1]
    assert "payables" not in co["hist"][-1], "upgrade() must not touch the parsed company"
    assert abs(u25["payables"] - 0.06 * h25["revenue"]) < 1e-6 and abs(u25["other_liab"] + u25["payables"]
                                                                          - h25["other_liab"]) < 1e-9, u25
    assert u25["lease"] == 30.0 and u25["borrowings"] == h25["borrowings"] - 30 and "lease" not in u24, u25
    assert u25["capex"] == u25["capex_cf"] == 88.25 == u24["capex"] and u25["fcf"] == 100.0 - 88.25, u25
    for u, h in zip(up["hist"], co["hist"]):  # the split never moves a total, a debt figure or a return ratio
        liab = u["share_cap"] + u["reserves"] + u["borrowings"] + (u.get("lease") or 0) + (u.get("payables") or 0)
        assert abs(liab + u["other_liab"] - h["total_liab"]) < 1e-9 and model._debt(u) == h["borrowings"], u
        assert all(u[k] == h[k] for k in RETURNS), u
    src = up["sources"]
    assert src["used"] == {"payables": ["FY2024", "FY2025"], "lease": ["FY2025"], "capex": ["FY2024", "FY2025"],
                           "capex_ar": []}, src
    assert src["basis"] == "cogs" and src["drivers"]["dpo"] == "Trade payables from XBRL FY2024, FY2025, on COGS", src
    assert src["notes"] == [], "the consolidated filing already covers FY2025; the second one is simply not needed"
    later = dict(co, dates=co["dates"][:-1], hist=co["hist"][:-1])  # FY2025 isn't in this file
    assert "isn't one of the reported years" in model.upgrade(later, [f25])["sources"]["notes"][0]
    note = model.upgrade(co, [off])["sources"]["notes"]
    assert len(note) == 1 and "off.xml" in note[0] and "1%" in note[0], note
    # no lease element: Screener's borrowings less the filing's (150 + 50) are the leases; equal = none
    d30 = dict(co, hist=[*co["hist"][:-1], dict(h25, borrowings=230.0, other_liab=h25["other_liab"] - 30)])
    assert model.upgrade(d30, [_filing(d30)])["hist"][-1]["lease"] == 30.0
    assert "lease" not in model.upgrade(co, [_filing(co)])["hist"][-1]
    big = model.upgrade(co, [_filing(co, -1, _fact("TradePayablesCurrent", 2 * h25["other_liab"]))])
    assert "payables" not in big["hist"][-1] and "exceed" in big["sources"]["notes"][0], big["sources"]
    # defaults: payable days and other liabilities from the split years only; capex per year where a filing has it
    d = model.default_assumptions(up["hist"])
    pay = up["hist"][-2:]
    assert abs(d["dpo"] - sum(h["payables"] * 365 for h in pay) / sum(h["cogs"] for h in pay)) < 1e-9, d["dpo"]
    assert abs(d["ol_pct"] - sum(h["other_liab"] for h in pay) / sum(h["revenue"] for h in pay)) < 1e-12, d["ol_pct"]
    r = model.ratios(up["hist"])
    assert d["capex_pct"] == statistics.median([r[-3]["capex_pct"], 88.25 / h24["revenue"], 88.25 / h25["revenue"]])
    assert r[-1]["dpo"] == u25["payables"] * 365 / u25["cogs"] and r[-3]["dpo"] is None, r[-1]
    pr = model.project(up["hist"], d, 5)
    for c in pr:
        assert abs(c["chk_bs"]) < 1e-6 and abs(c["chk_cash"]) < 1e-6 and c["lease"] == 30.0, c
        assert abs(c["payables"] - c["cogs"] * d["dpo"] / 365) < 1e-9 and abs(c["inventory"] - c["cogs"] * d["dio"] / 365) < 1e-9
    assert abs(pr[0]["interest"] - h25["borrowings"] * d["int_rate"]) < 1e-9, "interest runs on borrowings + leases"
    v = model.valuation({"base": pr}, up["hist"], None, model.expand(d, 5), co["market"])
    assert v["d"] == h25["borrowings"] == v["borrowings"] and v["lease"] == 30.0, (v["d"], v["lease"])
    # revenue basis: no raw material cost line (or under 10% of revenue): days on revenue exactly as before
    rev = dict(co, hist=[dict(h, cogs=None) for h in co["hist"]])
    up_rev = model.upgrade(rev, [f24, f25])
    assert not model.on_cogs(rev["hist"]) and up_rev["sources"]["basis"] == "revenue", up_rev["sources"]
    assert model.default_assumptions(rev["hist"])["dio"] == PINS["synthetic"]["defaults"]["dio"]
    assert model.on_cogs([dict(h, cogs=0.09 * h["revenue"]) for h in co["hist"]]) is False
    # approved annual-report capex (3.3) fills a year no filing covers; an XBRL cash flow for the year wins
    up_ar = model.upgrade(co, [f25], {"FY2023": 70.0, "FY2025": 1.0, "FY1999": 5.0})
    u23 = up_ar["hist"][-3]
    assert u23["capex"] == u23["capex_cf"] == 70.0 and u23["fcf"] == u23["cfo"] - 70.0, u23
    assert up_ar["hist"][-1]["capex"] == 88.25 and up_ar["sources"]["used"]["capex_ar"] == ["FY2023"], up_ar["sources"]
    assert up_ar["sources"]["drivers"]["capex_pct"] == ("Cash-flow capex from XBRL FY2025 and the annual report FY2023 "
                                                       "(approved); other years from the net block change")
    assert model.upgrade(co, [], None)["hist"] == model.upgrade(co)["hist"] == co["hist"], "no notes: unchanged"
    if not excel:
        return
    rows = {key: 5 + i for i, (_, key, _) in enumerate(model.LAYOUT) if key}
    first = model.labels(co["dates"])[0]  # cash-flow capex in the first reported year: FCF has no earlier column
    for name, comp in (("cogs", up), ("rev", up_rev), ("ar", model.upgrade(co, [], {"FY2023": 70.0})),
                       ("ar0", model.upgrade(co, [], {first: 70.0}))):
        base = {k: {"start": x, "end": None} for k, x in model.default_assumptions(comp["hist"]).items()}
        base.update(dpo={"start": 40.0, "end": 70.0}, cogs_pct={"start": 0.5, "end": 0.45}, debt_change={"start": -60.0, "end": None})
        sc = {"base": base, "bull": dict(base, growth={"start": 0.2, "end": None}),
              "bear": dict(base, dio={"start": 90.0, "end": 20.0}, capex_pct={"start": 0.3, "end": None})}
        ex = {s: model.expand(sc[s], 5) for s in model.SCENARIOS}
        projs = {s: model.project(comp["hist"], ex[s], 5) for s in model.SCENARIOS}
        v = model.valuation(projs, comp["hist"], None, ex["base"], comp["market"], ex)
        rh = model.ratios(comp["hist"])
        for i, s in enumerate(model.SCENARIOS):
            out = tmp / f"up-{name}-{s}"
            out.mkdir()
            (out / "model.xlsx").write_bytes(model.to_excel(comp, sc, n=5, active=s))
            ws = recalc(out / "model.xlsx", out / "calc")
            assert ws["B3"].value == i + 1
            for j, c in enumerate(projs[s]):
                assert abs(c["chk_bs"]) < 1e-6 and abs(c["chk_cash"]) < 1e-6, (name, s, j)
                _same(ws, rows, 2 + len(comp["hist"]) + j, {**c, **{k: x[j] for k, x in ex[s].items()}}, (name, s, j))
            _same_valuation(ws.parent["Valuation"], v, s)
        for j, h in enumerate(comp["hist"]):  # reported columns: values, ratio formulas, cash-flow capex as a value
            _same(ws, rows, 2 + j, {**{k: h.get(k) for k in ("cogs", "payables", "lease", "other_liab", "borrowings",
                                                            "capex", "fcf", "total_liab", *RETURNS)},
                                    **{k: rh[j][k] for k in ("cogs_pct", "dio", "dpo", "int_rate", "capex_pct", "ol_pct",
                                                             "debt_change")}}, (name, "hist", j))
        assert ("annual report and approved (FY2023)" if name == "ar" else f"annual report and approved ({first})"
                if name == "ar0" else "XBRL filings") in ws["A2"].value, ws["A2"].value
        assert ("on revenue" if name == "rev" else "on COGS") in ws["A2"].value


def _flat_scenarios(co):
    return dict.fromkeys(model.SCENARIOS, {k: {"start": v, "end": None}
                                           for k, v in model.default_assumptions(co["hist"]).items()})


def _same_quarters(qs, q):
    """The recalculated Quarters sheet: values as parsed, TTM column (live SUMs) and margins equal Python."""
    at = {c.value: c.row for c in qs["A"] if isinstance(c.value, str)}
    nq, t = len(q["dates"]), model.ttm(q)["values"]
    assert qs.cell(3, 2 + nq).value == f"TTM {q['dates'][-1]:%b %Y}", qs.cell(3, 2 + nq).value
    margin = lambda op, s: op / s if op is not None and s else None  # noqa: E731
    for label, key in model.Q_LAYOUT:
        vals = ([margin(o, s) for o, s in zip(q["rows"]["op_profit"], q["rows"]["sales"])]
                if key == "opm" else q["rows"][key])
        want = [*vals, margin(t["op_profit"], t["sales"]) if key == "opm" else t[key]]
        for j, v in enumerate(want):
            got = qs.cell(at[label], 2 + j).value
            if v is None:
                assert got in (None, ""), (key, j, got)
            else:
                assert isinstance(got, (int, float)) and abs(got - v) < 1e-6 * max(1, abs(v)), (key, j, got, v)


def valuation_check(co, projs, ex):
    """DCF arithmetic, written out by hand for the synthetic company (price 1600, 5 cr shares, 200 cr debt)."""
    v = model.valuation(projs, co["hist"], None, ex["base"], co["market"], ex)
    last, tax = co["hist"][-1], ex["base"]["tax_rate"][0]
    we = 8000 / 8200
    kd = min(max(ex["base"]["int_rate"][0], 0.065), 0.135)  # the default kd sits between rf and ke
    wacc = we * (0.065 + 1.0 * 0.07) + (1 - we) * kd * (1 - tax)
    assert v["wacc_build"] == v["wacc"], v["wacc_build"]
    assert abs(v["wacc"] - wacc) < 1e-15 and v["error"] is None and v["period"] == [0.5, 1.5, 2.5, 3.5, 4.5], v
    for s, rows in projs.items():
        f = [r["fcff"] for r in rows]
        for r, p in zip(rows, [last, *rows]):  # FCFF = NOPAT + dep - capex - change in NWC
            nwc = lambda x: x["receivables"] + x["inventory"] + x["other_ca"] - x["other_liab"]  # noqa: E731
            assert abs(r["fcff"] - ((r["ebitda"] - r["dep"]) * (1 - tax) + r["dep"] - r["capex"] - nwc(r) + nwc(p))
                       ) < 1e-9, (s, r["fcff"])  # tax is flat and equal in every scenario here
        pv = sum(x / (1 + wacc) ** (t + 0.5) for t, x in enumerate(f))
        tv = f[-1] * 1.05 / (wacc - 0.05) / (1 + wacc) ** 4.5
        eq = pv + tv - last["borrowings"] + last["cash"] + last["investments"]
        eq -= max(0.0, eq) * max(0.0, -ex["base"]["mi_pct"][0])  # minorities' share of profit
        got = v["scenarios"][s]
        assert abs(got["ev"] - (pv + tv)) < 1e-9 and abs(got["per_share"] - eq / 5) < 1e-9, (s, got["ev"], pv + tv)
        assert abs(got["upside"] - (eq / 5 / 1600 - 1)) < 1e-12 and got["grid"][2][2] == got["per_share"], s
        assert got["grid"][0][4] > got["grid"][2][2] > got["grid"][4][0], "lower WACC / higher growth = higher value"
        gm, a = got["grid_gm"], got["grid"]
        assert gm[2][2] == got["per_share"], (s, gm[2][2])  # the centre is the scenario as it stands
        down = lambda g: all(g[k][i] > g[k + 1][i] for k in range(4) for i in range(5))  # noqa: E731
        right = lambda g: all(g[k][i] < g[k][i + 1] for k in range(5) for i in range(4))  # noqa: E731
        # value falls as WACC rises (rows) and rises with terminal growth and with margin. No rule for revenue
        # growth: in the bear case (12% capex) growing faster destroys value at low margins, as it should
        assert down(a) and right(a) and right(gm), (s, a, gm)
        # a cell is the full projection re-run with the shift on every year
        up = dict(ex[s], growth=[x + 0.02 for x in ex[s]["growth"]], ebitda_margin=[x - 0.01 for x in ex[s]["ebitda_margin"]])
        one = model.valuation({s: model.project(co["hist"], up, 5)}, co["hist"], None, ex["base"], co["market"])
        assert abs(gm[3][1] - one["scenarios"][s]["per_share"]) < 1e-9, (s, gm[3][1])
    assert v["scenarios"]["bull"]["per_share"] > v["scenarios"]["base"]["per_share"] > v["scenarios"]["bear"]["per_share"]
    # reverse DCF: the implied flat growth, plugged back in, gives today's price (within 0.1%)
    # bear (12% capex) can't reach Rs 1,600 at any growth: value barely moves with it, so no solution in range
    # base tops out at Rs 1,524 at +80% once minorities take their 5%, so it is checked at a typed Rs 1,000
    assert v["scenarios"]["bear"]["implied_growth"] is None and v["scenarios"]["base"]["implied_growth"] is None
    for s, price in (("base", 1000.0), ("bull", 1600.0)):
        x = model.valuation(projs, co["hist"], {"price": price}, ex["base"], co["market"], ex)["scenarios"][s][
            "implied_growth"]
        back = model.valuation({s: model.project(co["hist"], dict(ex[s], growth=x), 5)}, co["hist"], {"price": price},
                               ex["base"], co["market"])["scenarios"][s]["per_share"]
        assert -0.3 < x < 0.8 and abs(back / price - 1) < 0.001, (s, x, back)
    # no solution in range, no price, and a WACC error all come back as None
    far = model.valuation(projs, co["hist"], {"price": 1e7}, ex["base"], co["market"], ex)
    assert far["scenarios"]["base"]["implied_growth"] is None, far["scenarios"]["base"]["implied_growth"]
    assert model.valuation(projs, co["hist"], None, ex["base"], None, ex)["scenarios"]["base"]["implied_growth"] is None
    # multiples, by hand: FY2016 at Rs 500 x 5 cr = 2,500 cr against net profit 120, EBITDA 200, book 450
    h0, mu = co["hist"][0], v["multiples"]
    assert abs(mu["hist"]["pe"][0] - 2500 / 120) < 1e-9 and abs(mu["hist"]["pb"][0] - 2500 / 450) < 1e-9, mu
    # EV grosses the market cap up by the 5% minority share, to match consolidated EBITDA
    assert abs(mu["hist"]["ev_ebitda"][0] - (2500 / 0.95 + 200 - h0["cash"] - 60) / 200) < 1e-9, mu
    assert mu["hist"]["pe"][-1] is None and mu["min"]["pe"] == mu["hist"]["pe"][-2]  # last year has no price
    assert mu["median"]["pe"] == statistics.median(mu["hist"]["pe"][:-1]) and mu["max"]["pe"] == 2500 / 120
    for s in model.SCENARIOS:
        m, sv = v["scenarios"][s]["multiples"], v["scenarios"][s]
        assert abs(m["price_last"]["pe"] - 8000 / last["pat"]) < 1e-9, m
        assert abs(m["value_next"]["pe"] - sv["equity"] / projs[s][0]["pat"]) < 1e-9, m
        assert abs(m["value_last"]["ev_ebitda"] - sv["ev"] / last["ebitda"]) < 1e-9, m
    assert model._multiples(100.0, 0.0, dict(last, pat=-1.0, ebitda=0.0, reserves=-last["share_cap"])) == dict.fromkeys(
        model.MULTIPLES)  # denominators <= 0 are blank
    assert model._multiples(-1.0, 0.0, last) == dict.fromkeys(model.MULTIPLES)  # so is a negative value
    assert model._hist_multiples(co["hist"], {}, 5.0)["median"] == dict.fromkeys(model.MULTIPLES)  # no price history
    bare = model.valuation(projs, co["hist"], None, ex["base"], None)
    nb = bare["scenarios"]["base"]
    assert nb["per_share"] is None and set(nb["multiples"]["value_last"].values()) == {None}, nb["multiples"]
    # year-end discounting is worth less than mid-year; typed price/shares win over market data
    ye = model.valuation(projs, co["hist"], {"mid_year": False, "price": 800.0, "shares": 10.0}, ex["base"], co["market"])
    assert ye["scenarios"]["base"]["ev"] < v["scenarios"]["base"]["ev"] and ye["e"] == 8000 and ye["price"] == 800, ye
    assert abs(ye["scenarios"]["base"]["ev"] * (1 + wacc) ** 0.5 - v["scenarios"]["base"]["ev"]) < 1e-6
    # WACC must clear growth by 0.5 pp; the grid blanks the cells that don't
    bad = model.valuation(projs, co["hist"], {"wacc_override": 0.054, "g": 0.05}, ex["base"], co["market"])
    assert bad["error"] and bad["scenarios"]["base"]["per_share"] is None, bad["error"]
    mid = bad["scenarios"]["base"]["grid"][2]  # WACC 5.4% against growth 4, 4.5, 5, 5.5, 6%
    assert None not in mid[:2] and mid[2:] == [None] * 3, mid
    assert "grid_gm" not in bad["scenarios"]["base"]  # only asked for with inputs
    bad = model.valuation(projs, co["hist"], {"wacc_override": 0.054, "g": 0.05}, ex["base"], co["market"], ex)
    assert bad["scenarios"]["bear"]["grid_gm"] == [[None] * 5] * 5  # same WACC and growth: every cell fails
    assert bad["scenarios"]["bear"]["implied_growth"] is None
    assert "above zero" in model.valuation(projs, co["hist"], {"wacc_override": -0.01, "g": -0.1}, ex["base"],
                                           None)["error"]
    # exactly 0.5 pp clears, whatever the float residue (0.055 - 0.05 = 0.00499999...)
    for w, g in ((0.055, 0.05), (0.105, 0.10), (0.13, 0.125)):
        edge = model.valuation(projs, co["hist"], {"wacc_override": w, "g": g}, ex["base"], co["market"])
        assert edge["error"] is None and edge["scenarios"]["base"]["per_share"] is not None, (w, g, edge["error"])
    assert "no WACC" in model.valuation(projs, co["hist"], {"price": 1e308, "shares": 1e308}, ex["base"], None)["error"]
    # a negative final-year FCFF gets no perpetuity: that scenario only is blank, with its own error
    burn = dict(projs, bear=model.project(co["hist"], dict(ex["bear"], capex_pct=0.4), 5))
    b = model.valuation(burn, co["hist"], None, ex["base"], co["market"], dict(ex, bear=dict(ex["bear"], capex_pct=0.4)))
    assert burn["bear"][-1]["fcff"] < 0 and b["error"] is None and b["scenarios"]["base"]["error"] is None, b["error"]
    bb = b["scenarios"]["bear"]
    assert "negative" in bb["error"] and bb["per_share"] is None and bb["grid"] == [[None] * 5] * 5, bb["error"]
    assert bb["implied_growth"] is None and b["scenarios"]["base"]["per_share"] == v["scenarios"]["base"]["per_share"]
    # the default kd is clamped between rf and ke; a typed one isn't
    for rate, want in ((0.30, 0.135), (0.01, 0.065)):
        hi = dict(ex["base"], int_rate=[rate] * 5)
        assert abs(model.valuation(projs, co["hist"], None, hi, co["market"])["kd"] - want) < 1e-15, rate
    assert model.valuation(projs, co["hist"], {"kd": 0.3}, ex["base"], co["market"])["kd"] == 0.3
    # minorities take their share of profit out of equity (base, first year); never out of a negative equity
    mb = dict(ex["base"], mi_pct=[-0.1] * 5)
    mv = model.valuation(projs, co["hist"], None, mb, co["market"])
    x, pre = mv["scenarios"]["base"], v["scenarios"]["base"]["ev"] - 200 + last["cash"] + last["investments"]
    assert mv["nci"] == 0.1 and abs(x["minority"] - 0.1 * pre) < 1e-9 and abs(x["equity"] - 0.9 * pre) < 1e-9, x
    assert abs(x["multiples"]["value_last"]["ev_ebitda"] - x["ev"] / last["ebitda"]) < 1e-9  # EV grossed back up
    debt = [*co["hist"][:-1], dict(last, borrowings=1e5)]  # net debt above EV
    neg = model.valuation(projs, debt, None, mb, co["market"])["scenarios"]["base"]
    assert neg["equity"] < 0 and neg["minority"] == 0, (neg["equity"], neg["minority"])


def note_check(co, projs, ex):
    """The research note's numbers (4.1): drivers_impact ranks and moves the right way, break-evens plug back to
    the price, the growth scale rises with growth, rolling CAGRs, key numbers and rule checks on the synthetic file."""
    v = model.valuation(projs, co["hist"], {"price": 1000.0}, ex["base"], co["market"], ex, note=True)
    nb, base = v["note"], v["scenarios"]["base"]["per_share"]
    assert model.valuation(projs, co["hist"], None, ex["base"], co["market"], ex)["note"] is None, "only when asked"
    imp = {d["key"]: d for d in nb["impact"]}
    swings = [d["swing"] for d in nb["impact"]]
    assert swings == sorted(swings, reverse=True) and len(imp) >= 8, nb["impact"]
    rises = ("ebitda_margin", "g", "dpo", "ol_pct", "growth", "dep_pct")  # up = more value (dep: tax shield)
    for k, d in imp.items():
        lo, hi = (d["down"], d["up"]) if k in rises else (d["up"], d["down"])
        assert lo < base < hi, (k, d, base)
    assert imp["wacc"]["down"] == v["scenarios"]["base"]["grid"][1][2] and imp["g"]["up"] == v["scenarios"]["base"]["grid"][2][3]
    assert abs(imp["ebitda_margin"]["up"] - v["scenarios"]["base"]["grid_gm"][2][3]) < 1e-9, "same step as the grid"
    assert "payout" not in imp and "oi_pct" not in imp, "no effect on a cash-flow-to-firm value"
    # break-evens: plugged back in (flat, every year), the value is the price
    be = nb["breakevens"]
    assert be["growth"]["value"] == v["scenarios"]["base"]["implied_growth"]
    per = lambda a, val=None: model.valuation({"base": model.project(co["hist"], a, 5)}, co["hist"], val or {"price": 1000.0},  # noqa: E731
                                              ex["base"], co["market"])["scenarios"]["base"]["per_share"]
    for k in ("growth", "ebitda_margin"):
        assert be[k]["value"] is not None and abs(per(dict(ex["base"], **{k: be[k]["value"]})) / 1000 - 1) < 1e-3, (k, be[k])
    assert abs(per(ex["base"], {"price": 1000.0, "wacc_override": be["wacc"]["value"]}) / 1000 - 1) < 1e-3, be["wacc"]
    # the price is twice our value: a lower WACC gets there; no terminal growth up to WACC - 0.5 pp does
    assert be["wacc"]["value"] < v["wacc"] and be["g"]["value"] is None and be["g"]["range"][1] < v["wacc"], be
    far = model.valuation(projs, co["hist"], {"price": 1e6}, ex["base"], co["market"], ex, note=True)["note"]["breakevens"]
    assert {k: x["value"] for k, x in far.items()} == dict.fromkeys(far), "nothing in range reaches Rs 10 lakh"
    gs = [y for _, y in nb["growth_scale"]]
    assert all(a < b for a, b in zip(gs, gs[1:])), gs  # base fades capex to 8%, so faster growth adds value here
    labels = model.labels(co["dates"])
    c3 = model.cagrs(co["hist"], labels, 3)
    assert len(c3) == 7 and all(abs(c["value"] - 0.12) < 1e-5 for c in c3) and c3[0]["from"] == "FY2016", c3
    keys = {k["key"]: k for k in model.key_numbers(co["hist"], labels)}
    assert abs(keys["growth"]["last"] - 0.12) < 1e-5 and abs(keys["ebitda_margin"]["typical"] - 0.2) < 1e-5, keys
    checks = model.rule_checks(co["hist"], labels, [], [])
    # synthetic CFO is 0.29x profit (its cash flow rows are made up): red over 3 and 5 years, and it lifts the
    # M-score (accruals); the rest clear, the annual-report checks wait for a filing
    assert [(c["id"], c["status"]) for c in checks] == [("cash", "red"), ("cash5", "red"), ("mscore", "amber"),
        ("dso", "clear"), ("dio", "clear"), ("cwip", "clear"), ("other_income", "clear"), ("tax", "clear"), ("debt", "clear"),
        ("cover", "clear"), ("nwc", "clear"), ("contingent", "filing"), ("related", "filing"), ("pledge", "filing"),
        ("auditor", "filing")], checks
    odd = [dict(h) for h in co["hist"]]
    odd[-1]["receivables"] *= 2.0  # receivable days double: red
    flags = [{"year": "FY2025", "metric": "tax_rate", "value": 0.45, "typical": 0.25}]
    got = model.rule_checks(odd, labels, flags, ["x"], {"ar:contingent:FY2025": {"total": 1e5}})
    assert [(c["id"], c["status"]) for c in got][:6] == [("oneoff-tax_rate-FY2025", "red"), ("cash", "red"),
        ("cash5", "red"), ("dso", "red"), ("contingent", "red"), ("data", "amber")], got
    forensic_check(co)
    assert model._inr(267021) == "2,67,021" and model._inr(-124) == "(124)" and model._inr(89185912) == "8,91,85,912"


def forensic_check(co):
    """4.3: every forensic rule trips on synthetic data built to trip it, at the severity its thresholds say, and stays
    quiet on a clean copy; the annual-report checks run only from approved notes."""
    labels = model.labels(co["dates"])
    clean = [dict(h, cfo=h["pat"]) for h in co["hist"]]  # cash = profit: nothing to flag
    notes_keys = ("contingent", "related", "pledge", "auditor")

    def sev(hist, notes=None):
        return {f["key"]: f["severity"] for f in model.forensic(hist, labels, notes)}

    base = sev(clean)
    assert all(v == "ok" for k, v in base.items() if k not in notes_keys), base
    radar = model.forensic(clean, labels)
    assert all(f["severity"] == "not_checked" and f["needs"] == "annual report" for f in radar if f["key"] in notes_keys)
    assert [f["key"] for f in radar] == ["cash", "cash5", "dso", "dio", "cwip", "other_income", "tax", "debt", "cover",
                                         "nwc", "mscore", *notes_keys], radar
    assert set(radar[0]) >= {"key", "title", "severity", "value", "threshold", "years", "detail"}, radar[0]

    def trip(key, edit, want, notes=None):
        h = [dict(x) for x in clean]
        edit(h)
        got = sev(h, notes)[key]
        assert got == want, (key, want, got, next(f for f in model.forensic(h, labels, notes) if f["key"] == key))

    def last(**kw):
        return lambda h: h[-1].update({k: v(h[-1]) if callable(v) else v for k, v in kw.items()})

    def years(n, **kw):
        return lambda h: [x.update({k: v(x) for k, v in kw.items()}) for x in h[-n:]]

    trip("cash", years(3, cfo=lambda x: 0.4 * x["pat"]), "high")
    trip("cash", years(3, cfo=lambda x: 0.7 * x["pat"]), "medium")
    trip("cash5", years(5, cfo=lambda x: 0.7 * x["pat"]), "medium")
    trip("cash", years(3, pat=lambda x: -10.0), "not_checked")  # losses: the ratio means nothing
    trip("dso", last(receivables=lambda x: 2.0 * x["receivables"]), "high")  # 44 -> 88 days
    trip("dso", last(receivables=lambda x: 1.6 * x["receivables"]), "medium")  # +60% but only 26 days: not high
    trip("dso", last(receivables=lambda x: 1.15 * x["receivables"]), "low")
    trip("dso", last(receivables=lambda x: 1.08 * x["receivables"]), "ok")
    trip("dio", last(inventory=lambda x: 2.0 * x["inventory"]), "high")
    trip("dio", years(10, inventory=lambda x: 0.0), "ok")  # a services firm: nothing to stretch
    trip("cwip", last(cwip=lambda x: 0.7 * x["net_block"]), "high")
    trip("cwip", last(cwip=lambda x: 0.4 * x["net_block"]), "medium")
    trip("cwip", years(4, cwip=lambda x: 0.4 * x["net_block"]), "ok")  # large but not rising: nothing piling up
    trip("other_income", years(3, other_income=lambda x: 0.6 * x["pbt"]), "high")
    trip("other_income", years(3, other_income=lambda x: 0.35 * x["pbt"]), "medium")
    trip("tax", last(tax=lambda x: 0.48 * x["pbt"]), "high")  # 25% -> 48%: 23 pp
    trip("tax", last(tax=lambda x: 0.37 * x["pbt"]), "medium")
    trip("tax", years(5, pbt=lambda x: -1.0), "not_checked")
    trip("debt", last(borrowings=lambda x: x["cash"] + x["investments"] + 4 * x["ebitda"]), "high")  # 4x EBITDA
    trip("debt", years(4, borrowings=lambda x: x["cash"] + x["investments"] + 2.5 * x["ebitda"]), "medium")  # level, no pace
    trip("debt", last(borrowings=600.0), "high")  # 200 -> 600 in 3 years (44% a year) vs EBITDA 12%, net debt 0.4x
    trip("debt", last(borrowings=600.0, cash=900.0), "ok")  # same pace, but net cash
    trip("cover", last(interest=lambda x: x["pbt"]), "medium")  # EBIT 2x interest
    trip("cover", last(interest=lambda x: 3 * x["pbt"]), "high")
    trip("nwc", last(other_ca=lambda x: x["other_ca"] + 0.2 * x["revenue"]), "high")
    trip("nwc", last(other_ca=lambda x: x["other_ca"] + 0.1 * x["revenue"]), "medium")
    trip("mscore", last(cfo=0.0), "medium")  # all profit as accruals: TATA 0.22 lifts M from -2.37 to about -1.3
    trip("mscore", last(cfo=None), "not_checked")
    m = next(f for f in model.forensic([dict(x) for x in clean[:-1]] + [dict(clean[-1], cfo=0.0)], labels) if f["key"] == "mscore")
    assert m["value"] > -1.78 and any("AQI" in a for a in m["approx"]) and any("SGAI" in a for a in m["approx"]) and m["parts"]["TATA"] > 0.2, m
    nw = clean[-1]["share_cap"] + clean[-1]["reserves"]
    trip("contingent", lambda h: None, "high", {"ar:contingent:FY2025": {"total": 0.3 * nw}})
    trip("contingent", lambda h: None, "medium", {"ar:contingent:FY2025": {"total": 0.15 * nw}})
    trip("contingent", lambda h: None, "ok", {"ar:contingent:FY2025": {"total": 0.05 * nw}})
    rev = clean[-1]["revenue"]
    rel = {"ar:related:FY2025": {"total": 2 * rev, "rows": [{"label": "Holding company: dividend paid", "amount": 2 * rev},
                                                             {"label": "Holding company: royalty", "amount": 0.02 * rev}]}}
    trip("related", lambda h: None, "ok", rel)  # dividends left out: paid pro rata to everyone
    trip("related", lambda h: None, "medium", {"ar:related:FY2025": {"total": 0.12 * rev, "rows": [
        {"label": "Group company: purchases", "amount": 0.12 * rev}]}})
    for pct, want in ((60, "high"), (30, "medium"), (5, "low"), (0, "ok")):
        trip("pledge", lambda h: None, want, {"ar:pledge:FY2025": {"total": pct}})
    aud = lambda op, changed=False, firm="A & Co LLP": {"auditor": firm, "opinion": op, "changed": changed}  # noqa: E731
    for note, want in ((aud("adverse"), "high"), (aud("disclaimer"), "high"), (aud("qualified"), "medium"),
                       (aud("unmodified", True), "low"), (aud("unmodified"), "ok")):
        trip("auditor", lambda h: None, want, {"ar:auditor:FY2025": note})
    trip("auditor", lambda h: None, "low", {"ar:auditor:FY2024": aud("unmodified", firm="B & Co"),
                                            "ar:auditor:FY2025": aud("unmodified")})  # the firm changed between years
    # the strip shows lit checks as red (high) / amber (medium, low); data-only gaps (losses) stay off it
    h = [dict(x) for x in clean]
    years(3, pat=lambda x: -10.0)(h)
    ids = [c["id"] for c in model.rule_checks(h, labels, [], [])]
    assert "cash" not in ids and "pledge" in ids, ids


def library_check(root, co, scenarios):
    """Local model library: round trip, one file per company per day, ids can't leave root."""
    import server  # noqa: PLC0415 (pulls in FastAPI; only this check needs it)
    from fastapi import HTTPException  # noqa: PLC0415

    def fails(fn, status, *args):
        try:
            fn(*args, root)
        except HTTPException as e:
            assert e.status_code == status, (fn.__name__, args, e.status_code, e.detail)
        else:
            raise AssertionError(f"{fn.__name__}{args}: expected {status}")

    q = co["quarters"]
    company = {"name": co["name"], "dates": [d.isoformat() for d in co["dates"]], "hist": co["hist"],
               "market": co["market"], "quarters": {"dates": [d.isoformat() for d in q["dates"]], "rows": q["rows"]}}
    old = server.ModelDoc.model_validate({"version": 3, "company": {k: company[k] for k in ("name", "dates", "hist")},
                                          "scenarios": scenarios})  # saved before market data and valuation existed
    assert old.company.market.price is None and old.company.market.price_hist == [], old.company.market
    assert old.version == 6 and old.valuation.model_dump() == model.VALUATION, old
    assert old.company.quarters is None and (old.filings, old.proposals, old.notes) == ([], [], {}), old
    # version 4 (Phases 1-2): opens as 6 with empty filings / proposals / notes, no quarters, empty Phase 4 blocks
    v4 = {"version": 4, "company": {k: company[k] for k in ("name", "dates", "hist", "market")}, "n": 5,
          "active": "bull", "scenarios": scenarios, "excluded_years": ["FY2020"], "saved_at": "2026-10-15T09:00:00",
          "valuation": model.VALUATION}
    up = server.ModelDoc.model_validate(v4).model_dump(mode="json")
    assert up == {**v4, "version": 6, "company": {**v4["company"], "quarters": None}, "filings": [], "proposals": [],
                  "notes": {}, "reports": [], "note": None, "assumption_sources": {}, "flag_notes": [], "reviewed_at": None}, up
    # saved before 3.4: no COGS line in the company, no cogs_pct / dpo in the scenarios. They come back as 0 (days stay
    # on revenue, payables stay in other liabilities) and the model projects exactly as it did
    pre = {k: {"start": x, "end": None} for k, x in PINS["synthetic"]["defaults"].items()}
    old34 = server.ModelDoc.model_validate(dict(v4, company=dict(v4["company"], hist=[
        {k: x for k, x in h.items() if k != "cogs"} for h in company["hist"]]), scenarios=dict.fromkeys(model.SCENARIOS, pre)))
    assert all(a["cogs_pct"].start == 0 and a["dpo"].start == 0 for a in old34.scenarios.values()), old34.scenarios
    _, _, _, out = old34.projection()
    assert [out["base"][0][k] for k in PIN_KEYS] == list(PINS["synthetic"]["first"]), "bit for bit as before 3.4"
    assert [out["base"][-1][k] for k in PIN_KEYS] == list(PINS["synthetic"]["last"])
    # quarters must have one value per date
    try:
        server.Company.model_validate(dict(company, quarters={"dates": q["dates"][:2], "rows": q["rows"]}))
        raise AssertionError("expected rejection: ragged quarters")
    except ValidationError:
        pass
    # a version-3 file on disk opens as version 4 with default valuation inputs, and lists
    (root / "old-co").mkdir(parents=True)
    (root / "old-co" / "2026-10-14.json").write_text(json.dumps(
        {"version": 3, "company": company, "n": 5, "active": "base", "scenarios": scenarios, "excluded_years": [],
         "saved_at": "2026-10-14T10:00:00"}))
    assert server.load_model("old-co/2026-10-14", root).model_dump(mode="json")["valuation"] == model.VALUATION
    assert [m["id"] for m in server.list_models(root)] == ["old-co/2026-10-14"]
    # valuation inputs that overflow to inf are a 422, not a 500 from the JSON encoder
    tiny = server.ModelRequest.model_validate({"company": company, "scenarios": scenarios,
                                               "valuation": {"shares": 1e-320}})
    fails(lambda _root: tiny.dcf(*tiny.projection()), 422)
    server.delete_model("old-co/2026-10-14", root)
    val = dict(model.VALUATION, beta=1.2, kd=0.085, mid_year=False, wacc_override=0.12, price=99.5, shares=3.25)
    # version 5 (Phase 3) opens as 6 with empty Phase 4 blocks
    v5 = {"version": 5, "company": company, "n": 7, "active": "bear", "scenarios": scenarios,
          "excluded_years": ["FY2020"], "saved_at": None, "valuation": val, "filings": [], "proposals": [],
          "notes": {}, "reports": []}
    assert server.ModelDoc.model_validate(v5).model_dump(mode="json") == {**v5, "version": 6, "note": None, "assumption_sources": {}, "flag_notes": [], "reviewed_at": None}
    data = {**v5, "version": 6, "note": None, "assumption_sources": {}, "flag_notes": [], "reviewed_at": None}
    assert server.restatements(co, root) is None, "nothing saved yet: no comparison"
    doc = server.ModelDoc.model_validate(data)
    mid, at = server.save_model(doc, root, now=datetime(2026, 10, 15, 12, 41, 5))
    assert (mid, at) == ("test-industries-ltd/2026-10-15", "2026-10-15T12:41:05"), (mid, at)
    back = server.load_model(mid, root).model_dump(mode="json")
    assert back == {**data, "saved_at": at}, "round trip must restore scenarios, fades, horizon, exclusions"
    assert back["scenarios"]["bear"]["growth"]["end"] is not None and back["scenarios"]["base"]["tax_rate"]["end"] is None
    restatement_check(server, root, co)
    # same day overwrites; a new day is a new version; the listing is newest first with final-year revenue
    server.save_model(doc.model_copy(update={"active": "bull"}), root, now=datetime(2026, 10, 15, 18, 0))
    server.save_model(doc, root, now=datetime(2026, 10, 16, 9, 0))
    listed = server.list_models(root)
    assert [(m["id"], m["active"]) for m in listed] == [
        ("test-industries-ltd/2026-10-16", "bear"), ("test-industries-ltd/2026-10-15", "bull")], listed
    want = model.project(co["hist"], model.expand(scenarios["bear"], 7), 7)[-1]["revenue"]
    assert listed[0]["revenue"] == want and listed[0]["n"] == 7 and listed[0]["year"] == "FY2032E", listed[0]
    # the landing's coverage row: value range, reverse DCF on base, flag count (typed price 99.5, 3.25 cr shares)
    vals = listed[0]["values"]
    assert listed[0]["price"] == 99.5 and vals["bull"] > vals["base"] > vals["bear"] and listed[0]["why"] is None, listed[0]
    assert listed[0]["flags"] == 3 and listed[0]["reviewed_at"] is None, listed[0]  # cash conversion 3 and 5 yrs, M-score
    (root / "test-industries-ltd" / "2026-10-14.json").write_text("{broken")  # skipped, not fatal
    assert len(server.list_models(root)) == 2
    fails(server.load_model, 422, "test-industries-ltd/2026-10-14")
    # ids are matched against a strict pattern before touching the disk
    (root.parent / "secret.json").write_text(json.dumps(data))
    for bad in ("../secret", "test-industries-ltd/../../secret", "/etc/passwd", "a/2026-10-15/../../x",
                "test-industries-ltd/2026-10-15.json", "Test/2026-10-15", "x\\..\\y/2026-10-15", "", "..", "%2e%2e/x"):
        fails(server.load_model, 422, bad)
        fails(server.delete_model, 422, bad)
    (root / "evil").symlink_to(root.parent, target_is_directory=True)  # a link out of the library
    fails(server.load_model, 422, "evil/2026-10-15")
    assert (root.parent / "secret.json").exists()
    assert server.slug("Tata Motors Ltd.") == "tata-motors-ltd" and server.slug("दूध").startswith("company-")
    assert server.slug("../..").startswith("company-")
    # malformed documents are refused
    for bad in ({**data, "version": 2}, {**data, "version": 7}, {**data, "active": "worst"},
                {**data, "valuation": dict(val, shares=0)}, {**data, "valuation": dict(val, g=float("nan"))},
                {**data, "scenarios": {k: v for k, v in scenarios.items() if k != "bull"}}):
        try:
            server.save_model(server.ModelDoc.model_validate(bad), root)
            raise AssertionError(f"expected rejection: {bad['version'], bad['active'], list(bad['scenarios'])}")
        except (HTTPException, ValueError):
            pass
    # a malformed company (missing, null or infinite numbers; no years; dates not matching years) is refused
    row = company["hist"][-1]
    for hist, dates in (([*company["hist"][:-1], {k: v for k, v in row.items() if k != "revenue"}], company["dates"]),
                        ([*company["hist"][:-1], dict(row, revenue=None)], company["dates"]),
                        ([*company["hist"][:-1], dict(row, revenue=float("nan"))], company["dates"]),
                        ([*company["hist"][:-1], dict(row, revenue=float("inf"))], company["dates"]),
                        ([], []), (company["hist"], company["dates"][:1])):
        try:
            server.ModelDoc.model_validate(dict(data, company=dict(company, hist=hist, dates=dates)))
            raise AssertionError(f"expected rejection: {len(hist)} years, {len(dates)} dates")
        except ValidationError:
            pass
    # one damaged file never hides the rest of the library
    (root / "poison").mkdir()
    (root / "poison" / "2026-10-15.json").write_text(json.dumps(dict(data, company=dict(company, hist=[]))))
    assert len(server.list_models(root)) == 2, server.list_models(root)
    fails(server.load_model, 422, "poison/2026-10-15")
    (root / "poison" / "2026-10-15.json").unlink()
    (root / "poison").rmdir()
    # two companies that slug the same keep separate files; the same company keeps its folder
    other = server.ModelDoc.model_validate(dict(data, company=dict(company, name="TEST INDUSTRIES LTD!")))
    oid, _ = server.save_model(other, root, now=datetime(2026, 10, 15, 13, 0))
    assert oid.startswith("test-industries-ltd-") and oid != mid, oid
    assert server.load_model(mid, root).company.name == "Test Industries Ltd"
    assert server.load_model(oid, root).company.name == "TEST INDUSTRIES LTD!"
    assert server.save_model(doc, root, now=datetime(2026, 10, 15, 14, 0))[0] == mid
    server.delete_model(oid, root)
    assert not list(root.glob("*/*.tmp")), "no temp files left behind"
    # delete removes the file, then the empty company folder; a second delete is a 404
    server.delete_model("test-industries-ltd/2026-10-16", root)
    server.delete_model("test-industries-ltd/2026-10-15", root)
    (root / "test-industries-ltd" / "2026-10-14.json").unlink()
    fails(server.delete_model, 404, "test-industries-ltd/2026-10-15")
    assert server.list_models(root) == []
    xbrl_api_check(server, root, co, data)
    ai_check(server, root, co, data)
    oneoff_check(server, root, data)
    ar_notes_check(server, root, co, data)
    flag_check(server, root, data)
    assume_check(server, root, data)
    reimport_check(server, root, co, data)


def reimport_check(server, root, co, data):
    """Uploading the export of a saved company again carries over its filings (read again by rules), proposals,
    notes and reports, so the same-day save never wipes them; the dashboard payload already uses them."""
    from fastapi.testclient import TestClient  # noqa: PLC0415

    client, models = TestClient(server.app), server.MODELS
    server.MODELS = root  # never the real library
    buf = io.BytesIO()
    fake_screener(buf)
    f25 = _filing(co, -1)  # not a kept raw file: carried as saved
    notes = {"ar:capex:FY2024": {"topic": "capex", "year": "FY2024", "total": 150.0}, "oneoff:FY2023": {"summary": "x"}}
    prop, rep = {"id": "p1", "kind": "oneoff_note", "status": "approved"}, {"id": "a" * 12, "file": "ar.pdf", "year": "FY2024", "pages": 3}
    try:
        doc = server.ModelDoc.model_validate(dict(data, filings=[f25], proposals=[prop], notes=notes, reports=[rep]))
        mid, _ = server.save_model(doc, root, now=datetime(2026, 10, 16, 9, 0))
        r = client.post("/api/parse", files={"file": ("x.xlsx", buf.getvalue())}).json()
        carry = r["restated"]["carry"]
        assert (carry["notes"], carry["proposals"], carry["reports"]) == (notes, [prop], [dict(rep, kind="annual")]), carry
        assert [f["id"] for f in carry["filings"]] == [f25["id"]], carry["filings"]
        assert r["hist"][-2]["capex"] == 150.0 and r["hist"][-1]["capex"] == 88.25, "the payload uses what carries over"
        server.delete_model(mid, root)
    finally:
        server.MODELS = models


FAKE_LLM = """import pathlib, sys
d = pathlib.Path(sys.argv[1])
n = len(list(d.glob("prompt-*.txt")))
(d / f"prompt-{n}.txt").write_text(sys.stdin.read())
replies = sorted(d.glob("reply-*.txt"))
sys.stdout.write(replies[min(n, len(replies) - 1)].read_text() if replies else "")
"""


def fake_llm(folder, *replies):
    """Point LLM_CMD at a script that logs each prompt and prints the canned replies in turn (then the last one
    again); returns a function giving the number of calls so far. Deterministic and offline."""
    import sys  # noqa: PLC0415
    import shlex  # noqa: PLC0415

    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    (folder / "fake_llm.py").write_text(FAKE_LLM)
    for i, r in enumerate(replies):
        (folder / f"reply-{i:02d}.txt").write_text(r if isinstance(r, str) else json.dumps(r))
    os.environ["LLM_CMD"] = shlex.join([sys.executable, str(folder / "fake_llm.py"), str(folder)])
    return lambda: len(list(folder.glob("prompt-*.txt")))


def _mapping_filing(co):
    """An annual filing with total expenses whose materials line sits under a company tag, a second revenue, a
    ratio and the fixture's royalty income: leftovers for the AI to map."""
    h = co["hist"][-1]
    extra = (_fact("Expenses", 900.0 + h["interest"] + h["dep"], "FourD") + _fact("EmployeeBenefitExpense", 200.0, "FourD")
             + _fact("OtherExpenses", 300.0, "FourD") + _fact("ManufacturingAndProcessingCost", 400.0, "FourD")
             + _fact("RevenueFromSaleOfServicesSegment", h["revenue"], "FourD")
             + '<xbrli:unit id="pure"><xbrli:measure>xbrli:pure</xbrli:measure></xbrli:unit>'
             '<in-bse-fin:DebtEquityRatio contextRef="FourD" unitRef="pure" decimals="2">0.40</in-bse-fin:DebtEquityRatio>')
    return fake_xbrl(co, extra=extra)


def ai_check(server, root, co, data):
    """3.2: the LLM (a fake LLM_CMD) proposes mappings for leftover tags, rules check them, approving saves to
    mappings.json and re-reads the filing by rules; /api/project and /api/export never call the LLM."""
    import ai  # noqa: PLC0415
    from fastapi.testclient import TestClient  # noqa: PLC0415

    assert not re.search(r"^\s*(import|from)\s+ai\b", Path(model.__file__).read_text(), re.M), "model.py imports ai"
    client, models, env = TestClient(server.app), server.MODELS, os.environ.pop("LLM_CMD", None)
    server.MODELS = root  # never the real library
    try:
        # no LLM_CMD: a calm message, and the rest of the app works
        st = client.get("/api/ai").json()
        assert (st["available"], st["message"]) == (False, ai.NOT_SET), st
        try:
            ai.llm("hi")
            raise AssertionError("expected LLMError")
        except ai.LLMError as e:
            assert str(e) == ai.NOT_SET
        assert ai.first_json('Sure! ```json\n[{"a": 1}]\n``` done') == [{"a": 1}]
        assert ai.first_json('{oops} then {"b": [2]}') == {"b": [2]}
        # bad JSON is retried once with the problem named, then a clear error
        calls = fake_llm(root / "llm", "not json at all", '{"tag": "x"}')
        try:
            ai.propose_mappings([{"tag": "X", "value": 1.0, "context": "c"}], model.XBRL_KEYS, {})
            raise AssertionError("expected LLMError")
        except ai.LLMError as e:
            assert "twice" in str(e) and "JSON array" in str(e), e
        assert calls() == 2 and "not usable" in (root / "llm" / "prompt-1.txt").read_text()
        calls = fake_llm(root / "llm", "Here you go:", '[{"tag": "X", "std_key": null, "reasoning": "a ratio"}]')
        assert ai.propose_mappings([{"tag": "X", "value": 1.0, "context": "c"}], model.XBRL_KEYS, {})[0]["tag"] == "X"
        assert calls() == 2

        company = json.dumps(data["company"])
        f = client.post("/api/xbrl", files={"file": ("fy.xml", _mapping_filing(co))}, data={"company": company}).json()
        assert (root / server.FILINGS / f"{f['id']}.xml").is_file(), "the uploaded file is kept for re-reading"
        tags = {u["tag"]: u for u in f["unmapped"]}
        assert set(tags) == {"RoyaltyIncome", "ManufacturingAndProcessingCost", "RevenueFromSaleOfServicesSegment",
                             "DebtEquityRatio"} and tags["DebtEquityRatio"]["unit"] == "pure", tags
        os.environ.pop("LLM_CMD")
        assert client.post("/api/mappings/propose", json={"filing": f}).status_code == 503
        reply = [
            {"tag": "ManufacturingAndProcessingCost", "std_key": "materials", "reasoning": "Cost of materials."},
            {"tag": "RevenueFromSaleOfServicesSegment", "std_key": "revenue", "reasoning": "Revenue."},  # double count
            {"tag": "RoyaltyIncome", "std_key": "royalty_income", "reasoning": "Royalty."},  # hallucinated key
            {"tag": "GhostTag", "std_key": "cwip", "reasoning": "Made up."},  # hallucinated tag
            {"tag": "DebtEquityRatio", "std_key": "bank_balances", "reasoning": "Wrong."},  # a ratio as money
            {"tag": "DebtEquityRatio", "std_key": None, "reasoning": "A second answer for one tag is ignored."},
        ]
        calls = fake_llm(root / "llm", "Mappings:\n" + json.dumps(reply))
        r = client.post("/api/mappings/propose", json={"filing": f})
        assert r.status_code == 200 and calls() == 1, r.text
        prompt = (root / "llm" / "prompt-0.txt").read_text()
        assert "ManufacturingAndProcessingCost = 400.0 Rs crore" in prompt and "- materials: cost of materials consumed" in prompt
        out = r.json()
        props = {p["source"]["tag"]: p for p in out["proposals"]}
        assert out["left"] == [] and len(props) == 5, out
        failed = lambda p: {c["name"] for c in p["checks"] if c["pass"] is False}  # noqa: E731
        good = props["ManufacturingAndProcessingCost"]
        assert failed(good) == set() and good["value"] == 400.0 and good["unit"] == "Rs crore", good
        assert any(c["name"] == "total_exp still ties" and c["pass"] for c in good["checks"]), good["checks"]
        assert (good["kind"], good["status"], good["ai"], good["filing"]) == ("mapping", "proposed", True, f["id"])
        assert failed(props["RevenueFromSaleOfServicesSegment"]) == {"Not counted twice"}
        assert failed(props["RoyaltyIncome"]) == {"A line this app knows"}
        assert failed(props["GhostTag"]) == {"The tag is in this filing"} and props["GhostTag"]["value"] is None
        assert failed(props["DebtEquityRatio"]) == {"Unit"}
        # rules on their own: sign, size, a total that tied before, two tags onto one line
        fx = {"facts": {"revenue": 1000.0, "total_exp": 600.0, "employee": 600.0},
              "unmapped": [{"tag": "A", "value": -5.0, "unit": "Rs crore", "context": "c"},
                           {"tag": "B", "value": 50000.0, "unit": "Rs crore", "context": "c"},
                           {"tag": "C", "value": 100.0, "unit": "Rs crore", "context": "c"}]}
        assert {c["name"] for c in model.mapping_checks(fx, "A", "ppe")[2] if c["pass"] is False} == {"Sign"}
        assert {c["name"] for c in model.mapping_checks(fx, "B", "goodwill")[2] if c["pass"] is False} == {"Size"}
        assert {c["name"] for c in model.mapping_checks(fx, "C", "other_exp")[2] if c["pass"] is False} == {"total_exp still ties"}
        assert {c["name"] for c in model.mapping_checks(fx, "C", "cash", ["cash"])[2] if c["pass"] is False} == {"Not counted twice"}

        # approve: saved to mappings.json, the filing re-read by rules, no LLM call
        body = {"filings": [f], "company": data["company"]}
        bad = client.post("/api/mappings/approve", json={**body, "proposal": props["RevenueFromSaleOfServicesSegment"]})
        assert bad.status_code == 422 and "already gives revenue" in bad.json()["detail"], bad.text
        r = client.post("/api/mappings/approve", json={**body, "proposal": good})
        assert r.status_code == 200, r.text
        a = r.json()
        assert a["proposal"]["status"] == "approved" and a["missing"] == [] and calls() == 1, a
        assert json.loads((root / server.MAPPINGS).read_text()) == {"ManufacturingAndProcessingCost": "materials"}
        g = a["filings"][0]
        assert g["id"] == f["id"] and g["file"] == "fy.xml" and g["facts"]["materials"] == 400.0, g
        assert "ManufacturingAndProcessingCost" not in {u["tag"] for u in g["unmapped"]}, g["unmapped"]
        assert server.list_models(root) == [], "mappings.json and _filings aren't models"
        # the next import applies it by rules: still no LLM call
        h = client.post("/api/xbrl", files={"file": ("fy.xml", _mapping_filing(co))}, data={"company": company}).json()
        assert h["facts"]["materials"] == 400.0 and calls() == 1, h["facts"]
        # /api/project and /api/export never call the LLM (and would fail loudly if they tried)
        req = {k: data[k] for k in ("company", "scenarios", "n", "valuation")} | {"filings": [g]}
        llm, ai.llm = ai.llm, None
        try:
            assert client.post("/api/project", json=req).status_code == 200
            assert client.post("/api/export", json=req).status_code == 200
        finally:
            ai.llm = llm
        assert calls() == 1, "project / export called the LLM"
        # reject keeps it for audit; an approved mapping taken back leaves mappings.json and the filing is re-read
        r = client.post("/api/mappings/reject", json={"filings": [g], "company": data["company"], "proposal": a["proposal"]})
        b = r.json()
        assert b["proposal"]["status"] == "rejected" and json.loads((root / server.MAPPINGS).read_text()) == {}, b
        assert "materials" not in b["filings"][0]["facts"] and calls() == 1, b["filings"][0]["facts"]
        r = client.post("/api/mappings/reject", json={**body, "proposal": props["GhostTag"]})
        assert r.json()["proposal"]["status"] == "rejected" and r.json()["filings"] == [f]
        assert client.post("/api/mappings/approve", json={**body, "proposal": {"kind": "ar_note"}}).status_code == 422
        # a filing attached before raw files were kept: the mapping is saved, the filing says to re-attach
        old = dict(f, id="0" * 12)
        r = client.post("/api/mappings/approve", json={"filings": [old], "proposal": dict(good, filing=old["id"])})
        assert r.json()["missing"] == ["fy.xml"] and r.json()["filings"] == [old], r.json()
        # a damaged mappings.json is never replaced by an approve (it would lose every approved mapping)
        (root / server.MAPPINGS).write_text('{"TagA": "revenue",\n}')
        r = client.post("/api/mappings/approve", json={**body, "proposal": good})
        assert r.status_code == 409 and (root / server.MAPPINGS).read_text() == '{"TagA": "revenue",\n}', r.text
        (root / server.MAPPINGS).unlink()
        # damaged unmapped entries in a document: the rules say so (422), no crash
        bad = dict(f, unmapped=[{"value": 1}, {"tag": "ManufacturingAndProcessingCost", "value": [1], "context": "c"}])
        r = client.post("/api/mappings/approve", json={"filings": [bad], "company": data["company"], "proposal": good})
        assert r.status_code == 422 and "isn't among" in r.json()["detail"], r.text
    finally:
        server.MODELS = models
        os.environ.pop("LLM_CMD", None)
        if env is not None:
            os.environ["LLM_CMD"] = env
        shutil.rmtree(root / server.FILINGS, ignore_errors=True)
        with contextlib.suppress(FileNotFoundError):
            (root / server.MAPPINGS).unlink()


def tiny_pdf(pages):
    """A minimal text PDF (one Helvetica line per string, each page a list of strings), stdlib only."""
    esc = lambda t: t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")  # noqa: E731
    n = len(pages)
    objs = ["<< /Type /Catalog /Pages 2 0 R >>",
            f"<< /Type /Pages /Kids [{' '.join(f'{4 + 2 * i} 0 R' for i in range(n))}] /Count {n} >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    for i, lines in enumerate(pages):
        body = "BT /F1 11 Tf 14 TL 50 750 Td " + " ".join(f"({esc(t)}) Tj T*" for t in lines) + " ET"
        objs += [f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> "
                 f"/Contents {5 + 2 * i} 0 R >>", f"<< /Length {len(body)} >>\nstream\n{body}\nendstream"]
    out, offs = "%PDF-1.4\n", []
    for i, o in enumerate(objs):
        offs.append(len(out))
        out += f"{i + 1} 0 obj\n{o}\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
    return (out + f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode("latin-1")


def oneoff_check(server, root, data):
    """3.2b: a flagged year explained in words. With a report, rules pick the pages and a quote that isn't on the cited
    page is rejected; without, it is marked as from the numbers only. Never used by /api/project or /api/export."""
    import ai  # noqa: PLC0415
    from fastapi.testclient import TestClient  # noqa: PLC0415

    client, models, env = TestClient(server.app), server.MODELS, os.environ.pop("LLM_CMD", None)
    server.MODELS = root  # never the real library
    company = json.loads(json.dumps(data["company"]))
    labels = model.labels([datetime.fromisoformat(d) for d in company["dates"]])
    i = len(labels) - 3
    company["hist"][i]["other_income"] *= 25  # one exceptional gain: other income far above its usual share
    year, end = labels[i], datetime.fromisoformat(company["dates"][i]).date()
    fy = f"{end.year - 1}-{end.year % 100:02d}"
    body = {"company": company, "year": year}
    try:
        assert client.post("/api/oneoffs/explain", json=body).status_code == 503, "no LLM_CMD: a calm 503"
        calls = fake_llm(root / "llm", {"summary": "Other income jumped. It looks like a one-time gain."})
        assert client.post("/api/oneoffs/explain", json=dict(body, year=labels[-1])).status_code == 422, "not flagged"
        # from the numbers only: no citation, labelled
        r = client.post("/api/oneoffs/explain", json=body)
        assert r.status_code == 200 and calls() == 1, r.text
        p = r.json()
        assert (p["kind"], p["status"], p["from_numbers"], p["period"], p["ai"]) == ("oneoff_note", "proposed", True, year, True), p
        assert p["source"] == {"file": None, "page": None, "quote": None, "tag": None} and p["value"].startswith("Other income")
        assert p["checks"] == [{"name": "Source", "pass": None, "detail": "From the numbers only, no filing read."}]
        # an approved capex note can flag a year, as on the dashboard; explain sees the same history
        cap = {f"ar:capex:{labels[-1]}": {"total": 0.9 * company["hist"][-1]["revenue"]}}
        r = client.post("/api/oneoffs/explain", json=dict(body, year=labels[-1], notes=cap))
        assert r.status_code == 200 and calls() == 2, r.text
        prompt = (root / "llm" / "prompt-0.txt").read_text()
        assert "No filing was read" in prompt and "other income was" in prompt and "Other income:" in prompt, prompt
        # a summary over two sentences is retried once, then a clear error
        calls = fake_llm(root / "llm", {"summary": "One. Two. Three."})
        r = client.post("/api/oneoffs/explain", json=body)
        assert r.status_code == 502 and "twice" in r.json()["detail"] and calls() == 2, r.text

        if not ai.pdf_available():
            print("pdftotext missing: skipped the annual-report part of the one-off check")
            return
        try:
            ai.pdf_pages(b"<html>")
            raise AssertionError("expected ValueError")
        except ValueError as e:
            assert "isn't a PDF" in str(e)
        pdf = tiny_pdf([[f"Annual Report {fy}", "Chairman's letter. We thank our shareholders."],
                        [f"Notes to the accounts for the year ended {end:%B} {end.day}, {end.year}",
                         "Other income includes an exceptional gain of Rs 900 crore",
                         "on the sale of our stake in a joint venture.", f"Financial year {fy}."],
                        [f"Board report {fy}", "Revenue grew steadily over the year."]])
        assert client.post("/api/report", files={"file": ("ar.pdf", b"not a pdf")}, data={"year": year}).status_code == 422
        r = client.post("/api/report", files={"file": ("ar.pdf", pdf)}, data={"year": year})
        assert r.status_code == 200, r.text
        rep = r.json()
        assert (rep["file"], rep["year"], rep["pages"], len(rep["id"])) == ("ar.pdf", year, 3, 12), rep
        assert (root / server.REPORTS / f"{rep['id']}.json").is_file() and server.list_models(root) == []
        pages = ai.pdf_pages(pdf)
        assert ai.pick_pages(pages, {"oi_pct"}, end) == [2], "only the page with exceptional items / other income"
        assert ai.mentions_year(pages, end) == 3
        # a quote copied from the cited page passes (case, spacing and curly quotes don't matter)
        good = {"summary": "An exceptional Rs 900 crore gain on selling a joint-venture stake lifted other income.",
                "page": 2, "quote": "OTHER income includes an  exceptional gain of Rs 900 crore on the sale of our stake"}
        calls = fake_llm(root / "llm", good)
        r = client.post("/api/oneoffs/explain", json=dict(body, report=rep))
        assert r.status_code == 200 and calls() == 1, r.text
        p = r.json()
        assert p["status"] == "proposed" and all(c["pass"] for c in p["checks"]), p["checks"]
        assert p["source"] == {"file": "ar.pdf", "page": 2, "quote": good["quote"], "tag": None} and not p["from_numbers"]
        prompt = (root / "llm" / "prompt-0.txt").read_text()
        assert "=== PAGE 2 ===" in prompt and "PAGE 1" not in prompt and "Chairman" not in prompt, prompt
        # a fabricated quote, or a page that wasn't sent, is rejected by the rules (and is its own record: the same
        # summary with another quote gets another id, so the client never replaces one with the other)
        gid = p["id"]
        for bad, failed in (({**good, "quote": "Other income includes a one-time insurance claim of Rs 900 crore"},
                             {"Quote is on the page"}),
                            ({**good, "page": 3, "quote": "Revenue grew steadily over the year."}, {"Page was read"})):
            fake_llm(root / "llm", bad)
            p = client.post("/api/oneoffs/explain", json=dict(body, report=rep)).json()
            assert p["status"] == "rejected" and {c["name"] for c in p["checks"] if c["pass"] is False} == failed, p
            assert p["id"] != gid and p["value"] == good["summary"]
            assert "Page was read" in failed or "so the explanation is rejected" in next(c["detail"] for c in p["checks"] if c["name"] == "Quote is on the page")
        # an approved note saves with the document and never feeds a number
        doc = dict(data, company=company, reports=[rep], proposals=[dict(p, status="approved")],
                   notes={f"oneoff:{year}": {"proposal": p["id"], "summary": p["value"], "file": "ar.pdf", "page": 2,
                                             "quote": good["quote"], "from_numbers": False, "ai": True}})
        mid, _ = server.save_model(server.ModelDoc.model_validate(doc), root, now=datetime(2026, 10, 16, 9, 0))
        back = server.load_model(mid, root).model_dump(mode="json")
        assert back["reports"] == [rep] and back["notes"] == doc["notes"], back["notes"]
        server.delete_model(mid, root)
        n, llm, ai.llm = calls(), ai.llm, None
        try:
            req = {k: doc[k] for k in ("company", "scenarios", "n", "valuation")}
            assert client.post("/api/project", json=req).status_code == 200
            assert client.post("/api/export", json=req).status_code == 200
        finally:
            ai.llm = llm
        assert calls() == n
        (root / server.REPORTS / f"{rep['id']}.json").unlink()
        r = client.post("/api/oneoffs/explain", json=dict(body, report=rep))
        assert r.status_code == 422 and "attach it again" in r.json()["detail"], r.text
    finally:
        server.MODELS = models
        os.environ.pop("LLM_CMD", None)
        if env is not None:
            os.environ["LLM_CMD"] = env
        shutil.rmtree(root / server.REPORTS, ignore_errors=True)


def ar_notes_check(server, root, co, data):
    """3.3: annual-report notes. Rules pick the pages per topic and show the prompt size first; the LLM (a fake
    LLM_CMD) extracts values with page and quote; rules convert units, check quotes and numbers and tie the sums to
    the statements; approving re-checks with no LLM call; an approved capex note feeds the capex history."""
    import ai  # noqa: PLC0415
    from fastapi.testclient import TestClient  # noqa: PLC0415

    client, models, env = TestClient(server.app), server.MODELS, os.environ.pop("LLM_CMD", None)
    server.MODELS = root  # never the real library
    h = co["hist"][-1]
    rev, seg = h["revenue"], round(0.6 * h["revenue"], 2)
    pdf = tiny_pdf([
        ["Annual Report 2024-25", "Chairman's letter. We thank our shareholders."],
        ["Notes to the consolidated financial statements for the year ended March 31, 2025",
         "Segment information (Rs in crore)", f"Steel revenue from operations {seg:,.2f}",
         f"Power revenue from operations {rev - seg:,.2f}"],
        ["Liquidity risk: contractual maturities of borrowings as at March 31, 2025 (Rs in crore)",
         "Due within 1 year 50.00", "Due in 1 to 5 years 120.00", "Due after 5 years 30.00"],
        ["Consolidated statement of cash flows for the year ended March 31, 2025 (Rs in crore)",
         "Cash flows from investing activities", "Purchase of property, plant and equipment (88.25)"],
        ["Contingent liabilities as at March 31, 2025 (Rs in crore)",
         "Claims against the Company not acknowledged as debts 12.50", "Income tax demands under appeal 7.25"],
        ["Related party transactions 2024-25 (Rs in lakh)", "Holding company royalty paid 1,250.00"],
        ["Shareholding of promoter and promoter group as at March 31, 2025", "Promoter holding 72.05% of share capital",
         "Shares pledged or otherwise encumbered: Nil"],
        ["Independent Auditor's Report to the Members, on the consolidated financial statements 2024-25",
         "Qualified Opinion. In our opinion, except for the effects of the matter described in the",
         "Basis for Qualified Opinion section, the statements give a true and fair view.",
         "For A B Shah & Co LLP, Chartered Accountants"],
    ])
    item = lambda label, amount, page, quote: {"label": label, "amount": amount, "page": page, "quote": quote}  # noqa: E731
    segs = {"found": True, "unit": "crore", "items": [
        item("Steel", seg, 2, f"steel revenue from  operations {seg:,.2f}"),
        item("Power", f"{rev - seg:,.2f}", 2, f"Power revenue from operations {rev - seg:,.2f}")]}
    try:
        if not ai.pdf_available():
            print("pdftotext missing: skipped the annual-report notes check")
            return
        rep = client.post("/api/report", files={"file": ("ar.pdf", pdf)}, data={"year": "FY2025"}).json()
        body = {"company": data["company"], "report": rep}
        # before anything is sent: the pages per topic and the exact prompt size, no LLM needed
        plan = client.post("/api/notes/plan", json=body).json()
        assert {t: x["pages"] for t, x in plan["topics"].items()} == {
            "segments": [2], "maturity": [3], "capex": [4], "contingent": [5], "related": [6], "pledge": [7], "auditor": [8]}, plan
        pages = ai.pdf_pages(pdf)
        end = datetime(2025, 3, 31).date()
        want = len(ai.note_prompt("segments", "FY2025", end, [(2, ai.page_text(pages[1]))]))
        assert plan["topics"]["segments"]["chars"] == want and plan["chars"] == sum(
            x["chars"] for x in plan["topics"].values()), plan
        ext = lambda topic, **kw: client.post("/api/notes/extract", json={**body, "topic": topic, **kw})  # noqa: E731
        assert ext("segments").status_code == 503, "no LLM_CMD: a calm 503"
        assert client.post("/api/notes/plan", json=dict(body, report=dict(rep, year="FY2031"))).status_code == 422
        # segments: values with page and quote, in crore, summing to Screener's revenue
        calls = fake_llm(root / "llm", "Here:\n" + json.dumps(segs))
        r = ext("segments")
        assert r.status_code == 200 and calls() == 1, r.text
        p = r.json()
        prompt = (root / "llm" / "prompt-0.txt").read_text()
        assert "=== PAGE 2 ===" in prompt and "PAGE 1 " not in prompt and "Chairman" not in prompt, prompt
        assert (p["kind"], p["field"], p["status"], p["unit"], p["period"], p["ai"]) == (
            "ar_note", "segments", "proposed", "Rs crore", "FY2025", True), p
        assert all(c["pass"] for c in p["checks"]), p["checks"]
        assert abs(p["value"]["total"] - rev) < 0.01 and p["value"]["rows"][1]["amount"] == round(rev - seg, 2), p["value"]
        assert p["source"] == {"file": "ar.pdf", "page": 2, "quote": segs["items"][0]["quote"], "tag": None}
        tie = next(c for c in p["checks"] if c["name"] == "Ties to the statements")
        assert "Screener's FY2025 revenue" in tie["detail"] and "within 2%" in tie["detail"], tie
        # a failing tie-out: one segment left out, the sum is 40% short, so rules reject it and approval refuses it
        short = dict(segs, items=segs["items"][:1])
        fake_llm(root / "llm", short)
        p_short = ext("segments").json()
        failed = lambda p: {c["name"] for c in p["checks"] if c["pass"] is False}  # noqa: E731
        assert p_short["status"] == "rejected" and failed(p_short) == {"Ties to the statements"}, p_short["checks"]
        r = client.post("/api/notes/approve", json={**body, "proposal": p_short})
        assert r.status_code == 422 and "40.0%" in r.json()["detail"], r.text
        # a fabricated quote, an amount that isn't in its quote, a page that wasn't sent, a unit the page doesn't use
        for bad, names in ((dict(segs, items=[dict(segs["items"][0], quote="Steel revenue rose to a record high"),
                                              segs["items"][1]]), {"Quotes are on their pages", "Numbers are in their quotes"}),
                           (dict(segs, items=[dict(segs["items"][0], amount=seg + 100), segs["items"][1]]),
                            {"Numbers are in their quotes", "Ties to the statements"}),
                           (dict(segs, items=[dict(segs["items"][0], page=3), segs["items"][1]]),
                            {"Pages were read", "Quotes are on their pages"}),
                           (dict(segs, unit="million"), {"Unit", "Ties to the statements"})):
            fake_llm(root / "llm", bad)
            q = ext("segments").json()
            assert q["status"] == "rejected" and failed(q) == names, (names, q["checks"])
        # units are converted by rules: lakh to crore (1,250 lakh = Rs 12.50 crore)
        fake_llm(root / "llm", {"found": True, "unit": "lakh", "items": [
            item("Holding company: royalty paid", "1,250.00", 6, "Holding company royalty paid 1,250.00")]})
        q = ext("related").json()
        assert q["status"] == "proposed" and q["value"]["rows"][0]["amount"] == 12.5, q
        assert q["value"]["against"] == {"label": "Revenue", "value": rev}, q["value"]
        # maturity buckets tie to borrowings (200) within 5%; capex ties to the XBRL cash flow when there is one
        fake_llm(root / "llm", {"found": True, "unit": "crore", "items": [
            item("Within 1 year", 50, 3, "Due within 1 year 50.00"), item("1-5 years", 120, 3, "Due in 1 to 5 years 120.00"),
            item("After 5 years", 30, 3, "Due after 5 years 30.00")]})
        q = ext("maturity").json()
        assert q["status"] == "proposed" and q["value"]["total"] == 200.0 == h["borrowings"], q["checks"]
        capex = {"found": True, "unit": "crore", "items": [
            item("Purchase of property, plant and equipment", "(88.25)", 4, "Purchase of property, plant and equipment (88.25)")]}
        fake_llm(root / "llm", capex)
        f25 = _filing(co, -1)
        assert f25["facts"]["purchase_ppe"] == 88.25
        q = ext("capex", filings=[f25]).json()
        assert q["status"] == "proposed" and "XBRL cash-flow capex" in q["checks"][-1]["detail"], q["checks"]
        off = dict(f25, facts=dict(f25["facts"], purchase_ppe=120.0))
        assert failed(ext("capex", filings=[off]).json()) == {"Ties to the statements"}
        # no filing: nothing to compare with (a note); approving re-checks by rules with no LLM call
        n = calls() + 1
        p_cap = ext("capex").json()
        assert p_cap["status"] == "proposed" and p_cap["checks"][-1]["pass"] is None and calls() == n, p_cap["checks"]
        assert p_cap["value"]["total"] == p_cap["value"]["rows"][0]["amount"] == 88.25, "an outflow in brackets is a size"
        # 4.3 topics: a pledge is a percentage ("Nil" quotes 0), the auditor's report is words checked against quotes
        fake_llm(root / "llm", {"found": True, "unit": "percent", "items": [
            item("Promoter shares pledged", 0, 7, "Shares pledged or otherwise encumbered: Nil")]})
        q = ext("pledge").json()
        assert q["status"] == "proposed" and q["value"]["total"] == 0 and q["unit"] == "% of promoter shares", q
        fake_llm(root / "llm", {"found": True, "unit": "percent", "items": [
            item("Promoter shares pledged", 140, 7, "Promoter holding 72.05% of share capital")]})
        assert failed(ext("pledge").json()) == {"Numbers are in their quotes"}, "140 isn't in the quote, nor 0-100"
        aud = {"found": True, "auditor": "A B Shah & Co LLP", "opinion": "qualified", "changed": False, "items": [
            {"label": "Opinion", "page": 8, "quote": "except for the effects of the matter described in the Basis for Qualified Opinion"},
            {"label": "Auditor", "page": 8, "quote": "For A B Shah & Co LLP, Chartered Accountants"}]}
        fake_llm(root / "llm", aud)
        p_aud = ext("auditor").json()
        assert p_aud["status"] == "proposed" and p_aud["value"]["opinion"] == "qualified" and p_aud["unit"] is None, p_aud
        assert next(c for c in p_aud["checks"] if c["name"] == "Change of auditor")["pass"] is None, p_aud["checks"]
        for bad, names in ((dict(aud, opinion="unmodified"), {"Opinion matches the quotes"}),
                           (dict(aud, auditor="Big Four LLP"), {"Firm is named"}),
                           (dict(aud, changed=True), {"Change of auditor"})):
            fake_llm(root / "llm", bad)
            assert failed(ext("auditor").json()) == names, names
        fake_llm(root / "llm", {"found": False})
        r = ext("contingent")
        assert r.status_code == 422 and "found no contingent liabilities" in r.json()["detail"], r.text
        calls = fake_llm(root / "llm", "not json", "still not json")
        r = ext("contingent")
        assert r.status_code == 502 and "twice" in r.json()["detail"] and calls() == 2, r.text
        llm, ai.llm = ai.llm, None  # from here on, any LLM call fails loudly
        try:
            r = client.post("/api/notes/approve", json={**body, "proposal": p})
            assert r.status_code == 200 and r.json()["status"] == "approved" and r.json()["id"] == p["id"], r.text
            r = client.post("/api/notes/approve", json={**body, "proposal": p_aud})
            assert r.status_code == 200 and r.json()["value"]["auditor"] == "A B Shah & Co LLP", r.text
            # an approved auditor note lights the radar on the next /api/company: qualified = medium (amber)
            got = client.post("/api/company", json={"company": data["company"], "notes": {
                "ar:auditor:FY2025": {**p_aud["value"], "proposal": p_aud["id"], "topic": "auditor", "year": "FY2025"}}}).json()
            assert next(f for f in got["forensic"] if f["key"] == "auditor")["severity"] == "medium", got["forensic"]
            assert next(c for c in got["rule_checks"] if c["id"] == "auditor")["status"] == "amber"
            tampered = dict(p, reply=dict(segs, items=[dict(segs["items"][0], quote="made up text here"), segs["items"][1]]))
            assert client.post("/api/notes/approve", json={**body, "proposal": tampered}).status_code == 422
            assert client.post("/api/notes/approve", json={**body, "proposal": {"kind": "mapping"}}).status_code == 422
            # an approved capex note feeds the capex history (sources say so); /api/project and /api/export use it
            notes = {"ar:capex:FY2025": {"proposal": p_cap["id"], "topic": "capex", "year": "FY2025",
                                         "total": 150.0, "rows": p_cap["value"]["rows"], "ai": True}}
            got = client.post("/api/company", json={"company": data["company"], "notes": notes}).json()
            assert got["sources"]["used"]["capex_ar"] == ["FY2025"] and got["hist"][-1]["capex"] == 150.0, got["sources"]
            plain = client.post("/api/company", json={"company": data["company"]}).json()
            assert plain["hist"][-1]["capex"] == 97.0 and got["defaults"]["capex_pct"] != plain["defaults"]["capex_pct"]
            req = {k: data[k] for k in ("company", "scenarios", "n", "valuation")}
            with_note = client.post("/api/project", json={**req, "notes": notes}).json()
            without = client.post("/api/project", json=req).json()
            assert with_note["scenarios"] == without["scenarios"], "history capex alone doesn't move projections"
            assert client.post("/api/export", json={**req, "notes": notes}).status_code == 200
            # the document keeps the proposals and notes (version 5)
            doc = dict(data, reports=[rep], proposals=[dict(p, status="approved"), p_short], notes=notes)
            mid, _ = server.save_model(server.ModelDoc.model_validate(doc), root, now=datetime(2026, 10, 16, 9, 0))
            back = server.load_model(mid, root).model_dump(mode="json")
            assert back["notes"] == notes and [x["status"] for x in back["proposals"]] == ["approved", "rejected"]
            server.delete_model(mid, root)
        finally:
            ai.llm = llm
        assert ai.amount("1,64,177") == 164177.0 and ai.amount("(34)") == -34.0 and ai.amount("n/a") is None
        assert ai.in_quote(164177.0, "Total 1,64,177") and not ai.in_quote(16417.0, "Total 1,64,177")
    finally:
        server.MODELS = models
        os.environ.pop("LLM_CMD", None)
        if env is not None:
            os.environ["LLM_CMD"] = env
        shutil.rmtree(root / server.REPORTS, ignore_errors=True)


def flag_check(server, root, data):
    """4.3: a lit forensic flag explained in words (fake LLM_CMD). From the numbers only it is labelled; with a report,
    rules pick the pages and check the quote; a number the app didn't compute rejects it; an unlit flag is a 422.
    Recalculating, exporting, refreshing and saving with flag notes never call the LLM."""
    import ai  # noqa: PLC0415
    from fastapi.testclient import TestClient  # noqa: PLC0415

    client, models, env = TestClient(server.app), server.MODELS, os.environ.pop("LLM_CMD", None)
    server.MODELS = root
    body = {"company": data["company"], "key": "cash"}  # synthetic CFO is 0.29x profit: high
    post = lambda b: client.post("/api/flags/explain", json=b)  # noqa: E731
    failed = lambda p: {c["name"] for c in p["checks"] if c["pass"] is False}  # noqa: E731
    try:
        assert post(body).status_code == 503, "no LLM_CMD: a calm 503"
        calls = fake_llm(root / "llm", {"summary": "Operating cash flow was 0.29x net profit over FY2023–FY2025. "
                                                    "Profit isn't turning into cash."})
        r = post(dict(body, key="cover"))
        assert r.status_code == 422 and "isn't flagged" in r.json()["detail"] and calls() == 0, r.text
        p = post(body).json()
        assert (p["kind"], p["field"], p["status"], p["from_numbers"], p["period"]) == ("flag_note", "cash", "proposed", True, "FY2025"), p
        assert [c["name"] for c in p["checks"]] == ["Source", "Numbers match"] and p["checks"][1]["pass"], p["checks"]
        prompt = (root / "llm" / "prompt-0.txt").read_text()
        assert "Cash conversion, 3 yrs" in prompt and "buy or sell" in prompt and "No filing was read" in prompt, prompt
        fake_llm(root / "llm", {"summary": "Cash fell Rs 4,321 crore short of profit."})
        q = post(body).json()
        assert q["status"] == "rejected" and failed(q) == {"Numbers match"} and "4,321" in q["checks"][-1]["detail"], q
        # dates, years and page references aren't figures; a figure from outside the quote is
        assert ai.numbers_check("At March 31, 2026 (FY2026, 2025-26), page 185 shows 4,301", "", "overdue 4,301")["pass"]
        assert not ai.numbers_check("It rose from 714 to 4,301", "", "overdue 4,301")["pass"]
        assert ai.numbers_check("29.1% of profit", "0.2913", None)["pass"], "a ratio may be written as a percentage"
        v = {"found": True, "auditor": "X LLP", "opinion": "Unqualified", "changed": None, "items": [{"label": "Opinion", "page": 1, "quote": "q"}]}
        assert ai.note_shape(v, "auditor") is None and (v["opinion"], v["changed"]) == ("unmodified", False), v
        if not ai.pdf_available():
            print("pdftotext missing: skipped the cited flag explanation")
            return
        pdf = tiny_pdf([["Annual Report 2024-25"], ["Directors' report 2024-25. Cash generated from operations fell",
                                                     "as trade receivables from a large customer were delayed."],
                        ["Financial year 2024-25 at a glance"], ["Notes 2024-25"]])
        rep = client.post("/api/report", files={"file": ("ar.pdf", pdf)}, data={"year": "FY2025"}).json()
        quote = "trade receivables from a large customer were delayed"
        fake_llm(root / "llm", {"summary": "A large customer paid late, so receivables rose.", "page": 2, "quote": quote})
        p2 = post(dict(body, report=rep)).json()
        assert p2["status"] == "proposed" and p2["source"]["page"] == 2 and not failed(p2), p2["checks"]
        assert "=== PAGE 2 ===" in (root / "llm" / "prompt-0.txt").read_text()
        fake_llm(root / "llm", {"summary": "A large customer paid late.", "page": 2, "quote": "receivables were written off"})
        assert "Quote is on the page" in failed(post(dict(body, report=rep)).json())
        llm, ai.llm = ai.llm, None  # from here on, any LLM call fails loudly
        try:
            req = {k: data[k] for k in ("company", "scenarios", "n", "valuation")}
            assert client.post("/api/project", json=req).status_code == 200
            assert client.post("/api/export", json=req).status_code == 200
            assert client.post("/api/company", json={"company": data["company"]}).status_code == 200
            fn = {"key": "cash", "year": "FY2025", "proposal": p2["id"], "summary": p2["value"], "file": "ar.pdf", "page": 2,
                  "quote": quote, "from_numbers": False, "ai": True}
            doc = dict(data, reports=[rep], proposals=[dict(p2, status="approved"), q], flag_notes=[fn])
            mid, _ = server.save_model(server.ModelDoc.model_validate(doc), root, now=datetime(2026, 10, 17, 9, 0))
            back = server.load_model(mid, root).model_dump(mode="json")
            assert back["flag_notes"] == [fn] and [x["kind"] for x in back["proposals"]] == ["flag_note"] * 2, back
            server.delete_model(mid, root)
        finally:
            ai.llm = llm
    finally:
        server.MODELS = models
        os.environ.pop("LLM_CMD", None)
        if env is not None:
            os.environ["LLM_CMD"] = env
        shutil.rmtree(root / server.REPORTS, ignore_errors=True)


def assume_check(server, root, data):
    """4.2: drafting every driver. Without documents or LLM_CMD every driver comes from history (the rule defaults);
    with a transcript, a fake LLM_CMD proposes, and rules pass a cited guided value (outside history, with a reason)
    and reject a made-up quote, an implausible value, a value outside history without a reason and the wrong
    bear/base/bull order. Accepting re-checks with no LLM call; recalculating and saving never call it."""
    import ai  # noqa: PLC0415
    from fastapi.testclient import TestClient  # noqa: PLC0415
    from pydantic import ValidationError  # noqa: PLC0415

    client, models, env = TestClient(server.app), server.MODELS, os.environ.pop("LLM_CMD", None)
    server.MODELS = root
    keys = [k for k, _, _ in model.DRIVERS]
    body = {"company": data["company"], "n": 5}
    post = lambda b: client.post("/api/assumptions/draft", json=b)  # noqa: E731
    failed = lambda p: {c["name"] for c in p["checks"] if c["pass"] is False}  # noqa: E731
    try:
        r = post(body).json()
        assert [p["field"] for p in r["proposals"]] == keys and all(p["from_history"] and not p["ai"] for p in r["proposals"]), r
        assert "No documents attached" in r["message"], r["message"]
        g = r["proposals"][0]["value"]
        assert abs(g["base"]["start"] - 0.12) < 1e-3 and abs(g["bull"]["start"] - g["base"]["start"] - 0.03) < 1e-12, g
        if not ai.pdf_available():
            print("pdftotext missing: skipped drafting from documents")
            return
        pdf = tiny_pdf([["Q4 FY2025 earnings call transcript", "Operator: welcome to the call."],
                        ["CEO: Going forward we expect revenue growth of 14 percent next year as the new plant ramps up,",
                         "with demand strong across both segments and pricing steady."],
                        ["CFO: Receivable days should come down to about 40 days as collections improve.",
                         "Our capex plan is modest and the dividend payout policy stays unchanged."]])
        assert client.post("/api/report", files={"file": ("call.pdf", pdf)}, data={"year": "FY2025", "kind": "memo"}).status_code == 422
        rep = client.post("/api/report", files={"file": ("call.pdf", pdf)}, data={"year": "FY2025", "kind": "transcript"}).json()
        assert rep["kind"] == "transcript", rep
        r = post(dict(body, reports=[rep])).json()
        assert all(p["from_history"] for p in r["proposals"]) and "LLM_CMD" in r["message"], r["message"]
        # a transcript is not an annual report: the notes and flag readers refuse it
        assert client.post("/api/flags/explain", json={"company": data["company"], "key": "cash", "report": rep}).status_code in (422, 503)
        q_growth = "we expect revenue growth of 14 percent next year as the new plant ramps up"
        q_dso = "Receivable days should come down to about 40 days as collections improve"
        q_capex = "Our capex plan is modest and the dividend payout policy stays unchanged"
        cite = lambda page, q: {"doc": "D1", "page": page, "quote": q}  # noqa: E731
        reply = {"drivers": [
            {"key": "growth", "from": "documents", "base": {"start": 14, "end": 12}, "bull": {"start": 16, "end": 14},
             "bear": {"start": 10, "end": None}, "reasoning": "Management guides 14% growth as the new plant ramps up.",
             "outside_history": "The new plant adds capacity the history didn't have.", **cite(2, q_growth)},
            {"key": "ebitda_margin", "from": "documents", "base": {"start": 24, "end": None}, "bull": {"start": 25, "end": None},
             "bear": {"start": 22, "end": None}, "reasoning": "Margins expand.", **cite(2, "margins will expand to 24 percent")},
            {"key": "payout", "from": "documents", "base": {"start": 150, "end": None}, "bull": {"start": 150, "end": None},
             "bear": {"start": 150, "end": None}, "reasoning": "Payout unchanged.", **cite(3, q_capex)},
            {"key": "capex_pct", "from": "documents", "base": {"start": 9, "end": None}, "bull": {"start": 9, "end": None},
             "bear": {"start": 9, "end": None}, "reasoning": "A modest capex plan.", **cite(3, q_capex)},
            {"key": "dso", "from": "documents", "base": {"start": 44, "end": None}, "bull": {"start": 47, "end": None},
             "bear": {"start": 41, "end": None}, "reasoning": "Collections improve to about 40 days.", **cite(3, q_dso)},
            {"key": "tax_rate", "from": "history"}]}
        calls = fake_llm(root / "llm", "Draft:\n" + json.dumps(reply))
        r = post(dict(body, reports=[rep])).json()
        assert calls() == 1 and [p["field"] for p in r["proposals"]] == keys, r
        by = {p["field"]: p for p in r["proposals"]}
        prompt = (root / "llm" / "prompt-0.txt").read_text()
        assert "=== D1 (FY2025 earnings-call transcript, call.pdf) PAGE 2 ===" in prompt and "buy or sell" in prompt, prompt[:400]
        assert "- growth (Revenue growth; unit percent" in prompt and "dpo" not in prompt.split("Pages from")[0], "no payables: no dpo"
        gp = by["growth"]
        assert gp["status"] == "proposed" and not failed(gp) and gp["ai"] and gp["source"]["page"] == 2, gp["checks"]
        assert gp["value"]["base"] == {"start": 0.14, "end": 0.12} and gp["value"]["bear"]["end"] is None, gp["value"]
        assert "the cited reason" in next(c["detail"] for c in gp["checks"] if c["name"] == "Against its history")
        assert failed(by["ebitda_margin"]) == {"Quote is on the page", "Against its history"}, by["ebitda_margin"]["checks"]
        assert by["ebitda_margin"]["status"] == "rejected"
        assert {"Plausible", "Payout vs cash"} <= failed(by["payout"]), by["payout"]["checks"]  # 150%: borrows to pay
        assert failed(by["capex_pct"]) == {"Against its history"}, by["capex_pct"]["checks"]  # 9% vs 3.5-6.5%, no reason
        assert failed(by["dso"]) == {"Bear ≤ base ≤ bull"}, by["dso"]["checks"]  # lower days are better
        assert by["tax_rate"]["from_history"] and by["oi_pct"]["from_history"], "uncovered drivers come from history"
        assert {c["name"] for c in gp["checks"]} == {"Quote is on the page", "Values parse", "Plausible", "Against its history",
                                                       "Bear ≤ base ≤ bull", "Numbers match"}, gp["checks"]
        cx = {c["name"]: c for c in by["capex_pct"]["checks"]}
        assert cx["Capex vs depreciation and growth"]["pass"] is True, cx
        # an invented number in the reasoning is rejected
        bad = dict(reply["drivers"][0], reasoning="Growth of 37% a year is guided.")
        fake_llm(root / "llm", {"drivers": [bad]})
        assert "Numbers match" in failed(post(dict(body, reports=[rep])).json()["proposals"][0])
        # accepting re-checks from the saved reply and page text, with no LLM call
        llm, ai.llm = ai.llm, None
        try:
            sc = data["scenarios"]
            chk = client.post("/api/assumptions/check", json=dict(body, reports=[rep], scenarios=sc,
                                                                 proposals=[gp, by["tax_rate"]])).json()["proposals"]
            assert [p["id"] for p in chk] == [gp["id"], by["tax_rate"]["id"]] and not failed(chk[0]) and chk[1]["from_history"], chk
            assert "Bear ≤ base ≤ bull" in failed(client.post("/api/assumptions/check", json=dict(
                body, reports=[rep], scenarios=sc, proposals=[by["dso"]])).json()["proposals"][0])
            tampered = dict(gp, reply=dict(gp["reply"], quote="growth will double"))
            assert "Quote is on the page" in failed(client.post("/api/assumptions/check", json=dict(
                body, reports=[rep], scenarios=sc, proposals=[tampered])).json()["proposals"][0])
            assert client.post("/api/assumptions/check", json=dict(body, scenarios=sc, proposals=[gp])).status_code == 422, "report gone"
            # accepted: ordinary assumptions plus where each came from; recalculating, exporting, saving never call the LLM
            acc = {s: dict(sc[s], growth=gp["value"][s]) for s in sc}
            srcs = {s: {"growth": gp["id"], "tax_rate": "history", "dso": "manual"} for s in sc}
            doc = dict(data, scenarios=acc, reports=[rep], proposals=[dict(gp, status="approved"), by["dso"]], assumption_sources=srcs)
            req = {k: doc[k] for k in ("company", "scenarios", "n", "valuation")}
            assert client.post("/api/project", json=req).status_code == 200
            assert client.post("/api/export", json=req).status_code == 200
            mid, _ = server.save_model(server.ModelDoc.model_validate(doc), root, now=datetime(2026, 10, 17, 9, 0))
            back = server.load_model(mid, root).model_dump(mode="json")
            assert back["assumption_sources"] == srcs and back["reports"] == [rep] and back["scenarios"] == acc, back["assumption_sources"]
            server.delete_model(mid, root)
            bad_src = dict(doc, assumption_sources={"base": {"growth": 3}})
            try:
                server.ModelDoc.model_validate(bad_src)
                raise AssertionError("assumption_sources must be {scenario: {driver: text}}")
            except ValidationError:
                pass
        finally:
            ai.llm = llm
        old = dict(data, version=5, reports=[{k: v for k, v in rep.items() if k != "kind"}])
        assert server.ModelDoc.model_validate(old).reports[0].kind == "annual", "reports saved before 4.2 are annual"
    finally:
        server.MODELS = models
        os.environ.pop("LLM_CMD", None)
        if env is not None:
            os.environ["LLM_CMD"] = env
        shutil.rmtree(root / server.REPORTS, ignore_errors=True)


def xbrl_api_check(server, root, co, data):
    """POST /api/xbrl reads a filing with the library's approved mappings; the filing saves and reopens with the model."""
    from fastapi.testclient import TestClient  # noqa: PLC0415

    client, models = TestClient(server.app), server.MODELS
    server.MODELS = root  # never the real library
    try:
        (root / server.MAPPINGS).write_text(json.dumps({"RoyaltyIncome": "royalty"}))
        assert server.list_models(root) == [], "mappings.json at the root isn't a model"
        # another site's page can't write to the library (a text/plain POST needs no CORS preflight)
        for h in ({"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}):
            r = client.post("/api/models", content=b"{}", headers={**h, "Content-Type": "text/plain"})
            assert r.status_code == 403, (h, r.text)
        assert client.post("/api/models", content=b"{}", headers={"Origin": "http://testserver"}).status_code == 422
        r = client.post("/api/xbrl", files={"file": ("q4.xml", fake_xbrl(co))},
                        data={"company": json.dumps(data["company"])})
        assert r.status_code == 200, r.text
        f = r.json()
        assert f["file"] == "q4.xml" and len(f["id"]) == 12 and f["facts"]["royalty"] == 4.2 and f["unmapped"] == [], f
        assert [c["pass"] for c in f["checks"]] == [True, True, True], f["checks"]
        (root / server.MAPPINGS).write_text("{damaged")
        assert server.load_mappings(root) == {}
        for body, status in ((b"x" * (server.MAX_UPLOAD + 1), 413), (b"<!DOCTYPE x><x/>", 422), (b"<a>", 422)):
            r = client.post("/api/xbrl", files={"file": ("bad.xml", body)})
            assert r.status_code == status and isinstance(r.json()["detail"], str), (status, r.text)
        r = client.post("/api/xbrl", files={"file": ("q4.xml", fake_xbrl(co))}, data={"company": "{}"})
        assert r.status_code == 422, r.text
        # an attached annual filing feeds /api/project, /api/export and the refreshed dashboard payload
        extra = _fact("TradePayablesCurrent", 0.06 * co["hist"][-1]["revenue"]) + _fact("LeaseLiabilitiesNoncurrent", 30.0)
        g = client.post("/api/xbrl", files={"file": ("fy2025.xml", fake_xbrl(co, extra=extra))},
                        data={"company": json.dumps(data["company"])}).json()
        req = {k: data[k] for k in ("company", "scenarios", "n", "valuation")}
        p = client.post("/api/company", json={"company": data["company"], "filings": [g]}).json()
        assert p["hist"][-1]["lease"] == 30.0 and p["company"]["hist"] == data["company"]["hist"], "document keeps the parse"
        assert p["sources"]["used"]["payables"] == ["FY2025"] and p["defaults"]["dpo"] > 0, p["sources"]
        assert client.post("/api/defaults", json={"company": data["company"], "filings": [g]}).json() == p["defaults"]
        with_f = client.post("/api/project", json={**req, "filings": [g]}).json()["scenarios"]["base"][0]
        without = client.post("/api/project", json=req).json()["scenarios"]["base"][0]
        assert with_f["lease"] == 30.0 and without["lease"] == 0.0 and abs(with_f["chk_bs"]) < 1e-6, (with_f, without)
        x = client.post("/api/export", json={**req, "filings": [g]})
        assert x.status_code == 200 and "XBRL filings" in openpyxl.load_workbook(io.BytesIO(x.content))["Model"]["A2"].value
    finally:
        server.MODELS = models
        (root / server.MAPPINGS).unlink()
    mid, _ = server.save_model(server.ModelDoc.model_validate(dict(data, filings=[g])), root)
    assert server.load_model(mid, root).upgraded()["hist"][-1]["lease"] == 30.0
    server.delete_model(mid, root)
    mid, _ = server.save_model(server.ModelDoc.model_validate(dict(data, filings=[f])), root)
    back = server.load_model(mid, root).model_dump(mode="json")["filings"]
    assert back == [f], "a filing (checks with 'pass', facts, unmapped) round-trips through the library"
    for bad in (dict(f, kind="weekly"), dict(f, facts={"revenue": "lots"})):
        try:
            server.ModelDoc.model_validate(dict(data, filings=[bad]))
            raise AssertionError(f"expected rejection: {bad['kind']}")
        except ValidationError:
            pass
    server.delete_model(mid, root)


def restatement_check(server, root, co):
    """A re-imported file vs the latest saved model: years that moved > 0.5% are listed, smaller moves aren't."""
    same = server.restatements(co, root)
    assert same["id"] == "test-industries-ltd/2026-10-15" and same["changes"] == [], same
    new = dict(co, hist=[dict(h) for h in co["hist"]])
    new["hist"][-2]["revenue"] *= 1.012  # FY2024 restated up 1.2%
    new["hist"][-2]["borrowings"] *= 1.004  # 0.4%: under the threshold
    new["hist"][-1]["pat"] *= 0.99  # FY2025 down 1%
    # one more year than saved and one fewer at the start: only overlapping years are compared
    new["dates"], new["hist"] = [*co["dates"][1:], datetime(2026, 3, 31)], [*new["hist"][1:], dict(co["hist"][-1])]
    got = server.restatements(new, root)["changes"]
    assert [(c["year"], c["line"]) for c in got] == [("FY2024", "Revenue"), ("FY2025", "Net profit")], got
    assert got[0]["old"] == co["hist"][-2]["revenue"] and got[0]["new"] == new["hist"][-3]["revenue"], got
    assert server.restatements(dict(co, name="Someone Else Ltd"), root) is None


RETURNS = ("roe", "roce", "asset_turnover", "nd_ebitda", "int_cover")
VAL_CELLS = {"Cost of debt, pre-tax": "kd", "Tax rate": "tax", "Share price (Rs)": "price", "Shares (crore)": "shares",
             "Minority share of profit": "nci",
             "Cost of equity = risk-free + beta x premium": "ke", "Cost of debt after tax": "kd_after_tax",
             "Equity (market cap; book equity if no price)": "e", "Debt (borrowings and lease liabilities)": "d",
             "Equity weight": "we", "WACC": "wacc", "Less borrowings and lease liabilities": "borrowings", "Plus cash & bank": "cash",
             "Plus investments": "investments"}
VAL_SCEN = {"PV of explicit years": "pv_sum", "Terminal value (Gordon growth on final-year FCFF)": "tv",
            "PV of terminal value": "pv_tv", "Enterprise value": "ev", "Less minority interest (estimate)": "minority",
            "Equity value": "equity", "Value per share (Rs)": "per_share", "Upside: value at": "upside",
            "Terminal value share of EV": "tv_share", "Revenue growth implied by share price": "implied_growth"}
VAL_YEARS = {"Free cash flow to firm": "fcff", "Discount factor": "df", "Present value": "pv"}


def _same_valuation(vs, v, s):
    """Every number on the recalculated Valuation sheet equals valuation() for scenario s (None = blank)."""
    at = {c.value: c.row for c in vs["A"] if isinstance(c.value, str)}
    sv, n = v["scenarios"][s], len(v["period"])
    cells = [(at[label], 2, v[k]) for label, k in VAL_CELLS.items()]
    # a label that carries the year end is matched by its start
    cells += [(at.get(label) or next(r for x, r in at.items() if x.startswith(label)), 2, sv[k])
              for label, k in VAL_SCEN.items()]
    cells += [(at["Discount period (years)"], 2 + j, p) for j, p in enumerate(v["period"])]
    cells += [(at[label], 2 + j, None if sv[k] is None else sv[k][j]) for label, k in VAL_YEARS.items() for j in range(n)]
    top = next(r for label, r in at.items() if label.startswith("VALUE PER SHARE (Rs): WACC"))
    cells += [(top, 2 + i, v["g"] + dg) for i, dg in enumerate(model.GRID_G)]
    cells += [(top + 1 + k, 1, v["wacc"] + dw) for k, dw in enumerate(model.GRID_WACC)]
    cells += [(top + 1 + k, 2 + i, x) for k, row in enumerate(sv["grid"]) for i, x in enumerate(row)]
    top = next(r for label, r in at.items() if label.startswith("VALUE PER SHARE (Rs): REVENUE")) + 1
    assert vs.cell(top, 2).value == "-2 pp" and vs.cell(top + 1, 1).value == "-4 pp", vs.cell(top, 2).value
    cells += [(top + 1 + k, 2 + i, x) for k, row in enumerate(sv["grid_gm"]) for i, x in enumerate(row)]
    # multiples: each reported year, then median / low / high, at price (last, next year), at value (last, next)
    mu = v["multiples"]
    for k, label in model.MULTIPLE_LABELS:
        cells += [(at[label], 2 + j, x) for j, x in enumerate(mu["hist"][k])]
        want = [mu["median"][k], mu["min"][k], mu["max"][k],
                *(sv["multiples"][b][k] for b in ("price_last", "price_next", "value_last", "value_next"))]
        cells += [(at[label.split(" (")[0]], 2 + i, x) for i, x in enumerate(want)]
    for r, c, want in cells:
        got = vs.cell(r, c).value
        if want is None:
            assert got in (None, ""), (s, vs.cell(r, 1).value, c, got)
        else:
            assert isinstance(got, (int, float)) and abs(got - want) < 1e-6 * max(1, abs(want)), (
                s, vs.cell(r, 1).value, c, got, want)


def _same(ws, rows, col, values, where):
    """Recalculated Excel column equals Python; Python None = blank cell."""
    for key, v in values.items():
        got = ws.cell(rows[key], col).value
        if v is None:
            assert got in (None, ""), (key, where, got)
        else:
            assert isinstance(got, (int, float)) and abs(got - v) < 1e-6 * max(1, abs(v)), (key, where, got, v)


def _edit_rows(path, fn):
    wb = openpyxl.load_workbook(path)
    for row in wb["Data Sheet"].iter_rows():
        fn(row[0].value, row)
    wb.save(path)


def _bankify(path):
    """Bank layout: same labels, Receivables/Inventory blank, interest ~half of sales."""
    def fn(label, row):
        if label in ("Receivables", "Inventory"):
            for c in row[1:]:
                c.value = None
        if label == "Interest":
            for c in row[1:]:
                c.value = 500.0
    _edit_rows(path, fn)


def _text_cell(path):
    _edit_rows(path, lambda label, row: label == "Tax" and setattr(row[3], "value", "1,000.00x"))


def _no_dimension(path):
    """Blank last Net profit cell and strip <dimension> so read_only rows come back ragged."""
    _edit_rows(path, lambda label, row: label == "Net profit" and setattr(row[-1], "value", None))
    with zipfile.ZipFile(path) as z:
        files = {n: z.read(n) for n in z.namelist()}
    files["xl/worksheets/sheet1.xml"] = re.sub(rb"<dimension[^>]*/>", b"", files["xl/worksheets/sheet1.xml"])
    with zipfile.ZipFile(path, "w") as z:
        for n, b in files.items():
            z.writestr(n, b)


def _blank(tmp):
    p = tmp / "blank.xlsx"
    openpyxl.Workbook().save(p)
    return p


if __name__ == "__main__":
    main()
