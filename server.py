"""Run: uv run uvicorn server:app  (serves the API and the built web/dist front end)."""
import contextlib
import hashlib
import io
import json
import math
import os
import re
import tempfile
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, ValidationError, model_validator

import model

MAX_UPLOAD = 5 * 1024 * 1024  # Screener exports are ~50 KB
MAX_SAVE = 512 * 1024  # a saved model document is ~10-20 KB
MODELS = Path(__file__).parent / "models"  # the local library, gitignored
MAPPINGS = "mappings.json"  # approved XBRL tag -> std key, at the library root (list_models only reads */*.json)
MODEL_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*/\d{4}-\d{2}-\d{2}")  # <company-slug>/<YYYY-MM-DD>
app = FastAPI()


@app.exception_handler(RequestValidationError)
def _invalid(_, exc):
    # the default handler echoes inputs back, and a NaN among them can't be JSON-encoded
    msgs = "; ".join(f"{'.'.join(map(str, e['loc'][1:]))}: {e['msg']}" for e in exc.errors())
    return JSONResponse({"detail": f"Invalid request: {msgs}"}, status_code=422)


@app.exception_handler(OSError)
def _disk(_, exc):
    # library reads and writes (full disk, read-only folder): say what failed instead of a bare 500
    return JSONResponse({"detail": f"Couldn't read or write the models folder: {exc.strerror or exc}."},
                        status_code=500)


REQUIRED = [*model.PL.values(), *model.BS.values(), "ebitda", "other_ca"]  # always numbers from parse_screener


class Market(BaseModel):
    """Share price (Rs) and count (crore) from the export; null when Screener left it out."""
    price: FiniteFloat | None = None
    shares: FiniteFloat | None = None
    price_hist: list[FiniteFloat | None] = []
    shares_hist: list[FiniteFloat | None] = []


class Quarters(BaseModel):
    """The export's Quarters block (model.QUARTERS keys), one value or null per quarter."""
    dates: list[datetime]
    rows: dict[str, list[FiniteFloat | None]]

    @model_validator(mode="after")
    def _lengths(self):
        if any(len(v) != len(self.dates) for v in self.rows.values()):
            raise ValueError("quarters need one value per quarter date in every row")
        return self


class Company(BaseModel):
    name: str
    dates: list[datetime]
    hist: list[dict[str, float | None]]
    market: Market = Market()  # version-3 documents saved before 2.1 have none
    quarters: Quarters | None = None  # none in the export (Milky Mist), or saved before 3.5

    @model_validator(mode="after")
    def _years(self):
        """Every endpoint and the library go through here, so a hand-made or damaged company is a 422."""
        if len(self.hist) < 2 or len(self.dates) != len(self.hist):
            raise ValueError("company needs at least two reported years, with one date per year")
        for i, row in enumerate(self.hist):
            bad = [k for k in REQUIRED if not isinstance(row.get(k), float) or not math.isfinite(row[k])]
            if bad:
                raise ValueError(f"company.hist[{i}] is missing numbers for {', '.join(bad)}")
        return self


class DriverPath(BaseModel):
    start: FiniteFloat
    end: FiniteFloat | None = None  # None = flat; else a straight fade from start to end over the projection


Scenario = Literal["base", "bull", "bear"]
V = model.VALUATION


class Valuation(BaseModel):
    """DCF inputs (model.VALUATION). kd None = base scenario's interest rate; price/shares None = market data."""
    rf: FiniteFloat = V["rf"]
    erp: FiniteFloat = V["erp"]
    beta: FiniteFloat = V["beta"]
    kd: FiniteFloat | None = V["kd"]
    g: FiniteFloat = V["g"]
    mid_year: bool = V["mid_year"]
    wacc_override: FiniteFloat | None = V["wacc_override"]
    price: FiniteFloat | None = Field(V["price"], gt=0)
    shares: FiniteFloat | None = Field(V["shares"], gt=0)


class ModelRequest(BaseModel):
    """The model document (version 4) minus what the engine ignores (excluded_years, saved_at)."""
    company: Company
    scenarios: dict[Scenario, dict[str, DriverPath]]
    active: Scenario = "base"
    n: int = 5
    valuation: Valuation = Valuation()

    def args(self):
        if not 1 <= self.n <= 15:
            raise HTTPException(422, "Projection years must be between 1 and 15.")
        if len(self.scenarios) != len(model.SCENARIOS):
            raise HTTPException(422, f"Need all three scenarios: {list(model.SCENARIOS)}")
        for s, a in self.scenarios.items():
            missing = {k for k, _, _ in model.DRIVERS} - a.keys()
            if missing:
                raise HTTPException(422, f"Missing assumptions in {s}: {sorted(missing)}")
        sc = {s: {k: v.model_dump() for k, v in a.items()} for s, a in self.scenarios.items()}
        return self.company.model_dump(), sc, self.n

    def projection(self):
        co, sc, n = self.args()
        out = {s: model.project(co["hist"], model.expand(sc[s], n), n) for s in model.SCENARIOS}
        for s, proj in out.items():
            if any(v is not None and not math.isfinite(v) for row in proj for v in row.values()):
                raise HTTPException(422, f"Those {s} assumptions make the numbers too large to project. "
                                         "Try smaller values.")
        return co, sc, n, out

    def dcf(self, co, sc, n, out):
        ex = {s: model.expand(sc[s], n) for s in model.SCENARIOS}
        v = model.valuation(out, co["hist"], self.valuation.model_dump(), ex["base"], co["market"], inputs=ex)
        try:  # extreme but finite inputs (shares 1e-320, rates 1e308) can overflow; JSON can't carry inf/NaN
            json.dumps(v, allow_nan=False)
        except ValueError:
            raise HTTPException(422, "Those valuation inputs make the numbers too large to value. Try smaller values.")
        return v


class Check(BaseModel):
    name: str
    pass_: bool | None = Field(alias="pass")  # None = nothing to compare with (a note)
    detail: str
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)


class Filing(BaseModel):
    """An attached XBRL filing (model.parse_xbrl plus id and file name). Read by rules; feeds no number yet."""
    id: str
    file: str
    kind: Literal["quarter", "half", "annual", "other"]
    company: str | None = None
    period_start: str | None = None
    period_end: str | None
    consolidated: bool | None = None
    facts: dict[str, FiniteFloat]
    unmapped: list[dict] = []
    checks: list[Check] = []
    model_config = ConfigDict(extra="allow")  # later Phase 3 features may add fields; keep them on save


class ModelDoc(ModelRequest):
    """The full model document as saved in the library. Version 3 (before valuation) loads with default inputs;
    versions 3 and 4 load with empty Phase 3 blocks."""
    version: Literal[3, 4, 5]
    excluded_years: list[str] = []
    saved_at: str | None = None
    # ponytail: untyped until the features that fill them land. proposals: [{id, kind (mapping | oneoff_note | ar_note), field, value, unit, period, source: {file,
    # page, quote, tag}, reasoning, checks: [{name, pass, detail}], status (proposed | approved | rejected), ai}];
    # notes: approved oneoff_note / ar_note results keyed for display
    filings: list[Filing] = []
    proposals: list[dict] = []
    notes: dict = {}

    @model_validator(mode="after")
    def _migrate(self):
        self.version = 5  # v3 -> v4 added "valuation", v4 -> v5 the blocks above; all already defaulted
        return self


def _company_payload(co, excluded=()):
    labels, q = model.labels(co["dates"]), co.get("quarters")
    return {
        "company": {"name": co["name"], "dates": [d.isoformat() for d in co["dates"]], "hist": co["hist"],
                    "market": co.get("market") or Market().model_dump(),
                    "quarters": q and {"dates": [d.isoformat() for d in q["dates"]], "rows": q["rows"]}},
        "ttm": model.ttm(q), "ttm_prev": model.ttm(q, 4),  # last four quarters, and the four before them
        "years": labels,
        "ratios": model.ratios(co["hist"]),
        "defaults": model.default_assumptions(co["hist"], exclude=set(excluded), labels=labels),
        "checks": model.data_checks(co),
        "oneoffs": model.detect_oneoffs(co["hist"], labels),
        "valuation": model.VALUATION,  # defaults for a new document
        "drivers": model.DRIVERS,
        "layout": model.LAYOUT,
    }


@app.post("/api/parse")
async def parse(file: UploadFile):
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "That file is over 5 MB. A Screener export is usually under 100 KB.")
    try:
        co = model.parse_screener(io.BytesIO(data))
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception:  # corrupt / not an xlsx
        raise HTTPException(422, "Couldn't read that file as an Excel workbook. Upload the .xlsx from "
                                 "Screener.in's 'Export to Excel' button.")
    return _company_payload(co) | {"restated": restatements(co)}


def load_mappings(root=MODELS):
    """The user's approved tag mappings ({tag: std key}); none when the file is missing or damaged."""
    try:
        m = json.loads((root / MAPPINGS).read_bytes())
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in m.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(m, dict) else {}


@app.post("/api/xbrl")
async def xbrl(file: UploadFile, company: str | None = Form(None)):
    """Read an XBRL results filing by rules (tie checks against `company`, the open model's company as JSON). The
    client adds the returned filing to its document's `filings`, and autosave stores it."""
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "That file is over 5 MB. A results XBRL filing is usually under 100 KB.")
    try:
        co = Company.model_validate_json(company).model_dump() if company else None
    except ValidationError:
        raise HTTPException(422, "The open model's company data is damaged; reload the model and try again.")
    try:
        f = model.parse_xbrl(data, mappings=load_mappings(MODELS), company=co)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"id": hashlib.sha1(data).hexdigest()[:12], "file": (file.filename or "filing.xml")[:200], **f}


@app.get("/api/sample")
def sample():
    from test_model import fake_screener  # ponytail: synthetic demo company, swap for a real export later
    buf = io.BytesIO()
    fake_screener(buf)
    buf.seek(0)
    return _company_payload(model.parse_screener(buf))


class DefaultsRequest(BaseModel):
    company: Company
    excluded_years: list[str] = []


@app.post("/api/defaults")
def defaults(req: DefaultsRequest):
    """Defaults with the user's excluded (one-off) years left out."""
    try:
        return model.default_assumptions(req.company.model_dump()["hist"], exclude=set(req.excluded_years),
                                         labels=model.labels(req.company.dates))
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.post("/api/project")
def project(req: ModelRequest):
    co, sc, n, out = req.projection()
    return {"years": [model.fy(d, True) for d in model.projected_dates(co, n)], "scenarios": out,
            "valuation": req.dcf(co, sc, n, out)}


@app.post("/api/export")
def export(req: ModelRequest):
    co, sc, n, _ = req.projection()
    safe = re.sub(r"[^\w\- ]+", "", co["name"], flags=re.ASCII).strip() or "company"  # headers are latin-1
    return Response(model.to_excel(co, sc, n, req.active, req.valuation.model_dump()),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{safe} model.xlsx"'})


# ---------- local model library: models/<company-slug>/<YYYY-MM-DD>.json, one file per company per day ----------

def slug(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:60].strip("-")
    return s or "company-" + hashlib.sha1(name.encode()).hexdigest()[:8]  # non-Latin names


def model_file(model_id, root=MODELS):
    """The file for an id, only ever inside root. Anything else is rejected, never resolved."""
    if not isinstance(model_id, str) or not MODEL_ID.fullmatch(model_id):
        raise HTTPException(422, "That isn't a valid model id.")
    p = (root / f"{model_id}.json").resolve()
    if not p.is_relative_to(root.resolve()):  # e.g. a symlinked folder pointing elsewhere
        raise HTTPException(422, "That isn't a valid model id.")
    return p


def save_model(doc: ModelDoc, root=MODELS, now=None):
    """Write today's version for this company (replacing any earlier one from today). Returns (id, saved_at)."""
    doc.args()  # all three scenarios, every driver, a sane horizon
    now = now or datetime.now()
    data = doc.model_dump(mode="json") | {"saved_at": now.isoformat(timespec="seconds")}
    try:
        text = json.dumps(data, allow_nan=False)
    except ValueError:
        raise HTTPException(422, "The model has numbers that aren't finite, so it can't be saved.")
    name, folder = doc.company.name, slug(doc.company.name)
    if any(_saved_name(f) not in (None, name) for f in (root / folder).glob("*.json")):
        folder += "-" + hashlib.sha1(name.encode()).hexdigest()[:6]  # another company slugs the same ("Tata Motors"/"TATA MOTORS!")
    model_id = f"{folder}/{now.date().isoformat()}"
    p = model_file(model_id, root)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".tmp")  # own temp file per write, so saves can't collide
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, p)  # atomic: a crash mid-write never leaves half a file
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp)  # only still there if the write failed
    return model_id, data["saved_at"]


def _saved_name(p):
    try:
        return json.loads(p.read_bytes())["company"]["name"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def load_model(model_id, root=MODELS):
    p = model_file(model_id, root)
    try:
        return ModelDoc.model_validate_json(p.read_bytes())
    except FileNotFoundError:
        raise HTTPException(404, "No saved model with that id. It may have been deleted.")
    except ValidationError:
        raise HTTPException(422, "That saved model is damaged or from an older version of the app.")


def list_models(root=MODELS):
    """Every saved version, most recent first. Unreadable files are skipped."""
    out = []
    for p in root.glob("*/*.json"):
        model_id = f"{p.parent.name}/{p.stem}"
        try:
            doc = load_model(model_id, root)
            co, sc, n = doc.args()
            last = model.project(co["hist"], model.expand(sc[doc.active], n), n)[-1]["revenue"]
        except Exception:  # noqa: BLE001
            continue  # ponytail: skip any unreadable file, never fail the whole list
        out.append({"id": model_id, "company": doc.company.name, "active": doc.active, "n": n,
                    "saved_at": doc.saved_at, "year": model.fy(model.projected_dates(co, n)[-1], True),
                    "revenue": last if last is not None and math.isfinite(last) else None})
    # ponytail: parses and projects every file per listing; fine for hundreds, add an index file past that
    return sorted(out, key=lambda m: m["saved_at"] or "", reverse=True)


RESTATED = (("revenue", "Revenue"), ("ebitda", "EBITDA"), ("pat", "Net profit"), ("total_assets", "Total assets"),
            ("borrowings", "Borrowings"))
RESTATE_TOL = 0.005  # 0.5%: Screener rounds lines to whole crores or 2 decimals, so less is noise


def restatements(co, root=MODELS):
    """Reported years in a freshly imported file that moved by more than 0.5% against the latest saved model of the
    same company: {id, saved_at, changes: [{year, line, old, new}]}, or None when nothing of it is saved."""
    saved = [p for p in root.glob(f"{slug(co['name'])}*/*.json") if _saved_name(p) == co["name"]]
    for p in sorted(saved, key=lambda p: p.stem, reverse=True):  # newest day first; a damaged file falls back
        model_id = f"{p.parent.name}/{p.stem}"
        try:
            doc = load_model(model_id, root)
        except HTTPException:
            continue
        old = {d.date(): h for d, h in zip(doc.company.dates, doc.company.hist)}
        changes = [{"year": y, "line": line, "old": o[k], "new": h[k]}
                   for y, d, h in zip(model.labels(co["dates"]), co["dates"], co["hist"]) if (o := old.get(d.date()))
                   for k, line in RESTATED
                   if o.get(k) is not None and abs(h[k] - o[k]) > max(RESTATE_TOL * abs(o[k]), 0.01)]
        return {"id": model_id, "saved_at": doc.saved_at, "changes": changes}
    return None


def delete_model(model_id, root=MODELS):
    p = model_file(model_id, root)
    try:
        p.unlink()
    except FileNotFoundError:
        raise HTTPException(404, "No saved model with that id.")
    try:
        p.parent.rmdir()  # last version of that company
    except OSError:
        pass


@app.get("/api/models")
def models():
    return list_models()


@app.get("/api/models/{model_id:path}")
def open_model(model_id: str):
    """The saved document plus everything the dashboard derives from the company, defaults honouring exclusions."""
    doc = load_model(model_id)
    try:
        parsed = _company_payload(doc.company.model_dump(), doc.excluded_years)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"id": model_id, "doc": doc.model_dump(mode="json"), "parsed": parsed}


@app.post("/api/models")
async def save(request: Request):
    body = bytearray()
    async for chunk in request.stream():  # read raw so the size cap applies before parsing
        body += chunk
        if len(body) > MAX_SAVE:
            raise HTTPException(413, "That model is too large to save.")
    try:
        doc = ModelDoc.model_validate_json(body)
    except ValidationError as e:
        raise RequestValidationError([{**x, "loc": ("body", *x["loc"])} for x in e.errors()])
    model_id, saved_at = save_model(doc)
    return {"id": model_id, "saved_at": saved_at}


@app.delete("/api/models/{model_id:path}")
def remove_model(model_id: str):
    delete_model(model_id)
    return {"ok": True}


dist = Path(__file__).parent / "web" / "dist"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True), name="web")
