"""Run: uv run uvicorn server:app  (serves the API and the built web/dist front end)."""
import hashlib
import io
import json
import math
import os
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, FiniteFloat, ValidationError

import model

MAX_UPLOAD = 5 * 1024 * 1024  # Screener exports are ~50 KB
MAX_SAVE = 512 * 1024  # a saved model document is ~10-20 KB
MODELS = Path(__file__).parent / "models"  # the local library, gitignored
MODEL_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*/\d{4}-\d{2}-\d{2}")  # <company-slug>/<YYYY-MM-DD>
app = FastAPI()


@app.exception_handler(RequestValidationError)
def _invalid(_, exc):
    # the default handler echoes inputs back, and a NaN among them can't be JSON-encoded
    msgs = "; ".join(f"{'.'.join(map(str, e['loc'][1:]))}: {e['msg']}" for e in exc.errors())
    return JSONResponse({"detail": f"Invalid request: {msgs}"}, status_code=422)


class Company(BaseModel):
    name: str
    dates: list[datetime]
    hist: list[dict[str, float | None]]


class DriverPath(BaseModel):
    start: FiniteFloat
    end: FiniteFloat | None = None  # None = flat; else a straight fade from start to end over the projection


Scenario = Literal["base", "bull", "bear"]


class ModelRequest(BaseModel):
    """The model document (version 3) minus what the engine ignores (excluded_years, saved_at)."""
    company: Company
    scenarios: dict[Scenario, dict[str, DriverPath]]
    active: Scenario = "base"
    n: int = 5

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


class ModelDoc(ModelRequest):
    """The full model document as saved in the library."""
    version: Literal[3]
    excluded_years: list[str] = []
    saved_at: str | None = None


def _company_payload(co, excluded=()):
    labels = [model.fy(d) for d in co["dates"]]
    return {
        "company": {"name": co["name"], "dates": [d.isoformat() for d in co["dates"]], "hist": co["hist"]},
        "years": labels,
        "ratios": model.ratios(co["hist"]),
        "defaults": model.default_assumptions(co["hist"], exclude=set(excluded), labels=labels),
        "checks": model.data_checks(co),
        "oneoffs": model.detect_oneoffs(co["hist"], labels),
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
    return _company_payload(co)


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
    labels = [model.fy(d) for d in req.company.dates]
    if len(labels) != len(req.company.hist):
        raise HTTPException(422, "company.dates and company.hist differ in length.")
    try:
        return model.default_assumptions(req.company.model_dump()["hist"], exclude=set(req.excluded_years),
                                         labels=labels)
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.post("/api/project")
def project(req: ModelRequest):
    co, _, n, out = req.projection()
    return {"years": [model.fy(d, True) for d in model.projected_dates(co, n)], "scenarios": out}


@app.post("/api/export")
def export(req: ModelRequest):
    co, sc, n, _ = req.projection()
    safe = re.sub(r"[^\w\- ]+", "", co["name"], flags=re.ASCII).strip() or "company"  # headers are latin-1
    return Response(model.to_excel(co, sc, n, req.active),
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
    model_id = f"{slug(doc.company.name)}/{now.date().isoformat()}"
    p = model_file(model_id, root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(text)
    os.replace(tmp, p)  # atomic: a crash mid-write never leaves half a file
    return model_id, data["saved_at"]


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
        except (HTTPException, OSError, ArithmeticError):
            continue
        out.append({"id": model_id, "company": doc.company.name, "active": doc.active, "n": n,
                    "saved_at": doc.saved_at, "year": model.fy(model.projected_dates(co, n)[-1], True),
                    "revenue": last if last is not None and math.isfinite(last) else None})
    # ponytail: parses and projects every file per listing; fine for hundreds, add an index file past that
    return sorted(out, key=lambda m: m["saved_at"] or "", reverse=True)


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
