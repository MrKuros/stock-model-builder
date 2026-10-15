"""Run: uv run python test_model.py  (Excel formula check needs LibreOffice `soffice` on PATH)."""
import io
import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

import openpyxl
from pydantic import ValidationError

import model


def fake_screener(path, years=10):
    """Synthetic file in Screener.in 'Data Sheet' layout with internally consistent numbers."""
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
    ws.append(["Report Date", *dates[:4]])
    ws.append(["Sales", 1, 2, 3, 4])  # must not clobber annual Sales
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
    library_check(tmp / "models", co, seeded)

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
        _same_valuation(ws.parent["Valuation"], model.valuation(projs, co["hist"], None, ex["base"], co["market"]), s)
    for j, h in enumerate(co["hist"]):  # historical ratio formulas, incl. first year on closing balances
        _same(ws, rows, 2 + j, {k: h[k] for k in ("ebitda", *RETURNS)}, ("hist", j))
    # zero interest and negative EBITDA must come out blank in both
    zero = dict(a, int_rate=0.0, ebitda_margin=-0.05)
    proj0 = model.project(co["hist"], zero, n=2)
    assert all(c["int_cover"] is None and c["nd_ebitda"] is None for c in proj0), proj0
    (tmp / "zero").mkdir()
    # ... with no market data (book equity weights, no per-share value), typed cost of debt, year-end discounting
    bare = dict(co, market=None)
    v0 = {"kd": 0.09, "mid_year": False, "rf": 0.07, "beta": 1.3, "g": 0.03}
    (tmp / "zero" / "model.xlsx").write_bytes(model.to_excel(bare, dict.fromkeys(model.SCENARIOS, zero), n=2, val=v0))
    ws0 = recalc(tmp / "zero" / "model.xlsx", tmp / "calc0")
    for j, c in enumerate(proj0):
        _same(ws0, rows, 2 + len(co["hist"]) + j, c, ("zero", j))
    flat0 = model.expand({k: {"start": v, "end": None} for k, v in zero.items()}, 2)
    val0 = model.valuation(dict.fromkeys(model.SCENARIOS, proj0), co["hist"], v0, flat0, None)
    assert val0["shares"] is None and val0["scenarios"]["base"]["per_share"] is None and val0["kd"] == 0.09, val0
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
    val10 = model.valuation(dict.fromkeys(model.SCENARIOS, proj10), co["hist"], v10, ep, co["market"])
    assert "0.5 pp" in val10["error"] and val10["scenarios"]["base"]["ev"] is None and val10["e"] == 8000, val10
    _same_valuation(ws10.parent["Valuation"], val10, "base")
    vs10 = ws10.parent["Valuation"]
    msg = vs10.cell(next(c.row for c in vs10["A"] if c.value == "WACC") + 1, 2).value  # the line under WACC
    assert msg.startswith("WACC must"), msg
    print("OK: parse, checks, projection, Excel formulas match Python")


def valuation_check(co, projs, ex):
    """DCF arithmetic, written out by hand for the synthetic company (price 1600, 5 cr shares, 200 cr debt)."""
    v = model.valuation(projs, co["hist"], None, ex["base"], co["market"])
    last, tax = co["hist"][-1], ex["base"]["tax_rate"][0]
    we = 8000 / 8200
    wacc = we * (0.065 + 1.0 * 0.07) + (1 - we) * ex["base"]["int_rate"][0] * (1 - tax)
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
        got = v["scenarios"][s]
        assert abs(got["ev"] - (pv + tv)) < 1e-9 and abs(got["per_share"] - eq / 5) < 1e-9, (s, got["ev"], pv + tv)
        assert abs(got["upside"] - (eq / 5 / 1600 - 1)) < 1e-12 and got["grid"][2][2] == got["per_share"], s
        assert got["grid"][0][4] > got["grid"][2][2] > got["grid"][4][0], "lower WACC / higher growth = higher value"
    assert v["scenarios"]["bull"]["per_share"] > v["scenarios"]["base"]["per_share"] > v["scenarios"]["bear"]["per_share"]
    # year-end discounting is worth less than mid-year; typed price/shares win over market data
    ye = model.valuation(projs, co["hist"], {"mid_year": False, "price": 800.0, "shares": 10.0}, ex["base"], co["market"])
    assert ye["scenarios"]["base"]["ev"] < v["scenarios"]["base"]["ev"] and ye["e"] == 8000 and ye["price"] == 800, ye
    assert abs(ye["scenarios"]["base"]["ev"] * (1 + wacc) ** 0.5 - v["scenarios"]["base"]["ev"]) < 1e-6
    # WACC must clear growth by 0.5 pp; the grid blanks the cells that don't
    bad = model.valuation(projs, co["hist"], {"wacc_override": 0.054, "g": 0.05}, ex["base"], co["market"])
    assert bad["error"] and bad["scenarios"]["base"]["per_share"] is None, bad["error"]
    mid = bad["scenarios"]["base"]["grid"][2]  # WACC 5.4% against growth 4, 4.5, 5, 5.5, 6%
    assert None not in mid[:2] and mid[2:] == [None] * 3, mid
    assert "above zero" in model.valuation(projs, co["hist"], {"wacc_override": -0.01, "g": -0.1}, ex["base"],
                                           None)["error"]


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

    company = {"name": co["name"], "dates": [d.isoformat() for d in co["dates"]], "hist": co["hist"],
               "market": co["market"]}
    old = server.ModelDoc.model_validate({"version": 3, "company": {k: company[k] for k in ("name", "dates", "hist")},
                                          "scenarios": scenarios})  # saved before market data and valuation existed
    assert old.company.market.price is None and old.company.market.price_hist == [], old.company.market
    assert old.version == 4 and old.valuation.model_dump() == model.VALUATION, old
    # a version-3 file on disk opens as version 4 with default valuation inputs, and lists
    (root / "old-co").mkdir(parents=True)
    (root / "old-co" / "2026-10-14.json").write_text(json.dumps(
        {"version": 3, "company": company, "n": 5, "active": "base", "scenarios": scenarios, "excluded_years": [],
         "saved_at": "2026-10-14T10:00:00"}))
    assert server.load_model("old-co/2026-10-14", root).model_dump(mode="json")["valuation"] == model.VALUATION
    assert [m["id"] for m in server.list_models(root)] == ["old-co/2026-10-14"]
    server.delete_model("old-co/2026-10-14", root)
    val = dict(model.VALUATION, beta=1.2, kd=0.085, mid_year=False, wacc_override=0.12, price=99.5, shares=3.25)
    data = {"version": 4, "company": company, "n": 7, "active": "bear", "scenarios": scenarios,
            "excluded_years": ["FY2020"], "saved_at": None, "valuation": val}
    doc = server.ModelDoc.model_validate(data)
    mid, at = server.save_model(doc, root, now=datetime(2026, 10, 15, 12, 41, 5))
    assert (mid, at) == ("test-industries-ltd/2026-10-15", "2026-10-15T12:41:05"), (mid, at)
    back = server.load_model(mid, root).model_dump(mode="json")
    assert back == {**data, "saved_at": at}, "round trip must restore scenarios, fades, horizon, exclusions"
    assert back["scenarios"]["bear"]["growth"]["end"] is not None and back["scenarios"]["base"]["tax_rate"]["end"] is None
    # same day overwrites; a new day is a new version; the listing is newest first with final-year revenue
    server.save_model(doc.model_copy(update={"active": "bull"}), root, now=datetime(2026, 10, 15, 18, 0))
    server.save_model(doc, root, now=datetime(2026, 10, 16, 9, 0))
    listed = server.list_models(root)
    assert [(m["id"], m["active"]) for m in listed] == [
        ("test-industries-ltd/2026-10-16", "bear"), ("test-industries-ltd/2026-10-15", "bull")], listed
    want = model.project(co["hist"], model.expand(scenarios["bear"], 7), 7)[-1]["revenue"]
    assert listed[0]["revenue"] == want and listed[0]["n"] == 7 and listed[0]["year"] == "FY2032E", listed[0]
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
    for bad in ({**data, "version": 2}, {**data, "version": 5}, {**data, "active": "worst"},
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


RETURNS = ("roe", "roce", "asset_turnover", "nd_ebitda", "int_cover")
VAL_CELLS = {"Cost of debt, pre-tax": "kd", "Tax rate": "tax", "Share price (Rs)": "price", "Shares (crore)": "shares",
             "Cost of equity = risk-free + beta x premium": "ke", "Cost of debt after tax": "kd_after_tax",
             "Equity (market cap; book equity if no price)": "e", "Debt (borrowings)": "d", "Equity weight": "we",
             "WACC": "wacc", "Less borrowings": "borrowings", "Plus cash & bank": "cash",
             "Plus investments": "investments"}
VAL_SCEN = {"PV of explicit years": "pv_sum", "Terminal value (Gordon growth on final-year FCFF)": "tv",
            "PV of terminal value": "pv_tv", "Enterprise value": "ev", "Equity value": "equity",
            "Value per share (Rs)": "per_share", "Upside vs share price": "upside",
            "Terminal value share of EV": "tv_share"}
VAL_YEARS = {"Free cash flow to firm": "fcff", "Discount factor": "df", "Present value": "pv"}


def _same_valuation(vs, v, s):
    """Every number on the recalculated Valuation sheet equals valuation() for scenario s (None = blank)."""
    at = {c.value: c.row for c in vs["A"] if isinstance(c.value, str)}
    sv, n = v["scenarios"][s], len(v["period"])
    cells = [(at[label], 2, v[k]) for label, k in VAL_CELLS.items()]
    cells += [(at[label], 2, sv[k]) for label, k in VAL_SCEN.items()]
    cells += [(at["Discount period (years)"], 2 + j, p) for j, p in enumerate(v["period"])]
    cells += [(at[label], 2 + j, None if sv[k] is None else sv[k][j]) for label, k in VAL_YEARS.items() for j in range(n)]
    top = next(r for label, r in at.items() if label.startswith("VALUE PER SHARE"))
    cells += [(top, 2 + i, v["g"] + dg) for i, dg in enumerate(model.GRID_G)]
    cells += [(top + 1 + k, 1, v["wacc"] + dw) for k, dw in enumerate(model.GRID_WACC)]
    cells += [(top + 1 + k, 2 + i, x) for k, row in enumerate(sv["grid"]) for i, x in enumerate(row)]
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
