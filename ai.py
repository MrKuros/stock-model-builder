"""Reading and judging with a language model, provider-neutral and with no SDK: the shell command in LLM_CMD gets
the prompt on stdin and prints the reply on stdout. model.py never imports this module. Nothing returned here
becomes a number by itself: callers turn it into a proposal that rules check and the user approves."""
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import unicodedata
from datetime import date

TIMEOUT = 180  # seconds per call
NOT_SET = "Set LLM_CMD to a command that reads a prompt on stdin and prints the reply, then restart."


class LLMError(Exception):
    """The command is missing, failed, timed out, or twice gave no usable JSON. The message is for the user."""


def available():
    return bool(os.environ.get("LLM_CMD", "").strip())


def llm(prompt: str) -> str:
    """One call: run LLM_CMD with the prompt on stdin, return its stdout."""
    cmd = os.environ.get("LLM_CMD", "").strip()
    if not cmd:
        raise LLMError(NOT_SET)
    try:
        r = subprocess.run(shlex.split(cmd), input=prompt, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        raise LLMError(f"LLM_CMD gave no reply within {TIMEOUT} seconds.") from None
    except (OSError, ValueError) as e:  # not found, not executable, unbalanced quotes
        raise LLMError(f"Couldn't run LLM_CMD ({e}).") from None
    if r.returncode:
        raise LLMError(f"LLM_CMD exited with code {r.returncode}: {(r.stderr or r.stdout).strip()[-300:]}")
    return r.stdout


def first_json(text):
    """The first JSON object or array in a reply (models wrap JSON in prose or code fences); ValueError if none."""
    dec = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch in "[{":
            try:
                return dec.raw_decode(text, i)[0]
            except ValueError:
                continue
    raise ValueError("no JSON object or array in the reply")


def ask_json(prompt, shape):
    """Ask for JSON only. `shape(value)` returns None when the value is usable, else what's wrong with it. A bad reply
    is retried once with the problem named; a second bad one raises LLMError."""
    ask = prompt + "\n\nReply with the JSON only, no other text."
    why = None
    for _ in range(2):
        reply = llm(ask if why is None else f"{ask}\n\nYour previous reply was not usable: {why}. Try again.")
        try:
            v = first_json(reply)
            why = shape(v)
        except ValueError as e:
            why = str(e)
        if why is None:
            return v
    raise LLMError(f"The model's reply wasn't usable JSON twice ({why}). Try again, or use another LLM_CMD.")


def _mapping_shape(v):
    if not isinstance(v, list):
        return "expected a JSON array"
    for x in v:
        if not (isinstance(x, dict) and isinstance(x.get("tag"), str) and isinstance(x.get("reasoning", ""), str)
                and (x.get("std_key") is None or isinstance(x["std_key"], str))):
            return 'each item must be {"tag": string, "std_key": string or null, "reasoning": string}'
    return None


def propose_mappings(unmapped, keys, filing):
    """[{tag, std_key | None, reasoning}] for a filing's unmapped facts, given the std keys {key: meaning}."""
    lines = "\n".join(f"- {u['tag']} = {u['value']} {u.get('unit') or ''} (context {u['context']})" for u in unmapped)
    known = "\n".join(f"- {k}: {m}" for k, m in keys.items())
    prompt = (
        "You map XBRL facts from an Indian listed company's financial results filing (Ind AS, NSE/BSE results "
        f"taxonomy) to a fixed list of statement lines. The filing is a {filing.get('kind')} to "
        f"{filing.get('period_end')}; amounts are in Rs crore.\n\n"
        f"These facts were not recognised:\n{lines}\n\nThe statement lines (std_key: meaning):\n{known}\n\n"
        f"Lines the filing already reports under their standard tags: {', '.join(filing.get('facts', {})) or 'none'}.\n\n"
        "For each fact, give the std_key it is the same line as, or null when it is a breakdown, a segment, a "
        "subtotal of something else, a ratio, or not one of these lines. Never map a fact to a line the filing "
        "already reports under its standard tag. Give one short sentence of reasoning.\n"
        'Answer as a JSON array: [{"tag": "...", "std_key": "..." or null, "reasoning": "..."}].')
    return ask_json(prompt, _mapping_shape)


# ---------- annual-report PDFs: page text by rules (system pdftotext), shared by one-off notes and later AR notes ----------

PDF_MISSING = "Reading PDFs needs pdftotext (poppler-utils). Install it, then restart."
PDF_TIMEOUT = 120  # seconds per pdftotext run; a 350-page report takes ~2 s


def pdf_available():
    return shutil.which("pdftotext") is not None


def pdf_pages(data: bytes):
    """[(reading-order text, layout text)] per page, from the system pdftotext. Reading order keeps a sentence in
    one piece on multi-column pages (sent to the model); -layout keeps table rows together (quotes are checked
    against both). ValueError with a message for the user when it isn't a readable, text-bearing PDF."""
    if not data.startswith(b"%PDF-"):
        raise ValueError("That isn't a PDF. Attach the annual report as a .pdf file.")
    if not pdf_available():
        raise ValueError(PDF_MISSING)
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "report.pdf")
        with open(src, "wb") as f:
            f.write(data)
        out = []
        for flags in ([], ["-layout"]):
            try:
                r = subprocess.run(["pdftotext", "-q", "-enc", "UTF-8", *flags, src, "-"], capture_output=True,
                                   timeout=PDF_TIMEOUT)
            except subprocess.TimeoutExpired:
                raise ValueError(f"pdftotext took over {PDF_TIMEOUT} seconds on that PDF.") from None
            if r.returncode:
                raise ValueError("pdftotext couldn't read that PDF (damaged or password-protected?).")
            pages = r.stdout.decode("utf-8", "replace").split("\f")
            out.append(pages[:-1] if pages and not pages[-1].strip() else pages)  # a form feed ends every page
    raw, lay = out
    if len(raw) != len(lay) or not any(p.strip() for p in raw):
        raise ValueError("No text could be read from that PDF (a scanned report?). Explain from the numbers instead.")
    return list(zip(raw, lay))


_PUNCT = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-",
                        "−": "-", "­": None, " ": " "})


def norm(s):
    """Case, whitespace, curly quotes, dashes and ligatures (NFKC) don't count when matching a quote."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s).translate(_PUNCT)).strip().lower()


def year_re(end: date):
    """How an Indian annual report writes the financial year ending `end` (31 Mar 2020): 2019-20, FY 2020, FY20,
    March 31, 2020, 31st March, 2020. Matched against norm() text."""
    y, m, d = end.year, end.strftime("%B").lower(), end.day
    return re.compile(rf"\b{y - 1}\s?-\s?(?:{y % 100:02d}|{y})\b|\bfy\s?'?(?:{y}|{y % 100:02d})\b"
                      rf"|\b{d}(?:st|nd|rd|th)?\s{m},?\s{y}\b|\b{m}\s{d}(?:st|nd|rd|th)?,?\s{y}\b")


# words that point at the page explaining each one-off metric (model.ONEOFF keys); "exceptional" counts for all
ONEOFF_WORDS = {"oi_pct": ("other income", "fair value", "impairment", "write-off", "write off", "profit on sale"),
                "tax_rate": ("tax expense", "deferred tax", "effective tax", "tax rate", "minimum alternate tax",
                             "tax credit", "tax holiday"),
                "capex_pct": ("purchase of property, plant", "capital expenditure", "capex", "acquisition",
                              "right-of-use", "amalgamation", "merger", "business combination"),
                "ebitda_margin": ("margin", "impairment", "provision", "write-off", "write off", "one-off")}
COMMON_WORDS = (("exceptional", 3), ("one-time", 3), ("one time", 3), ("one-off", 3), ("non-recurring", 3))
MAX_PAGES, MAX_PAGE_CHARS = 4, 8000  # ponytail: the 4 best-scoring pages, cut to 8k characters each (~10k tokens)


def pick_pages(pages, metrics, end: date):
    """Rules choose what the model reads: page numbers (1-based) of up to 4 pages that mention exceptional /
    one-time items or the flagged line and the year, best first. A page needs a word hit, not just the year."""
    words = [*COMMON_WORDS, *((w, 2) for k in metrics for w in ONEOFF_WORDS.get(k, ()))]
    yr, scored = year_re(end), []
    for i, (raw, _) in enumerate(pages):
        t = norm(raw)
        hits = sum(min(t.count(w), 5) * wt for w, wt in words)
        if hits:
            scored.append((hits + min(len(yr.findall(t)), 5), -i))
    return [-i + 1 for _, i in sorted(scored, reverse=True)[:MAX_PAGES]]


def mentions_year(pages, end: date):
    """Pages that name the financial year: a report for that year names it on many pages."""
    yr = year_re(end)
    return sum(1 for raw, _ in pages if yr.search(norm(raw)))


def sentences(s):
    # ponytail: a full stop followed by a capital starts a sentence; "Ltd. The" counts two, fine for a limit
    return len(re.findall(r"[.!?](?=\s+[A-Z(\"']|\s*$)", s.strip())) or 1


def _note_shape(cited):
    def shape(v):
        if not isinstance(v, dict) or not isinstance(v.get("summary"), str) or not v["summary"].strip():
            return 'expected {"summary": string' + (', "page": number, "quote": string}' if cited else "}")
        if sentences(v["summary"]) > 2 or len(v["summary"]) > 700:
            return "the summary must be at most two sentences"
        if cited and not (isinstance(v.get("page"), int) and isinstance(v.get("quote"), str) and v["quote"].strip()):
            return '"page" must be a page number and "quote" the exact text copied from that page'
        return None
    return shape


def explain_oneoff(year, flags, numbers, pages=None):
    """Words only: why `year` was unusual. With `pages` [(page number, text)] from the annual report the reply is
    {summary, page, quote}, the quote copied from that page; without, {summary} from the numbers alone."""
    what = "\n".join(f"- {f['note']}" for f in flags)
    prompt = (f"An Indian listed company's {year} stood out from its own history:\n{what}\n\n"
              f"Its reported figures (Rs crore):\n{numbers}\n\n")
    if pages:
        text = "\n\n".join(f"=== PAGE {n} ===\n{t[:MAX_PAGE_CHARS]}" for n, t in pages)
        prompt += (f"Pages from its annual report (only these were read):\n{text}\n\n"
                   "Using only these pages, say in at most two sentences (under 80 words) what made the year unusual (an exceptional "
                   "item, an acquisition, a tax change...). Give the page number it is on and a quote of 5 to 40 "
                   "words copied character for character from that page as evidence. If the pages don't explain it, "
                   "say so in the summary and quote the closest relevant sentence.\n"
                   'Answer as a JSON object: {"summary": "...", "page": number, "quote": "..."}.')
    else:
        prompt += ("No filing was read. From these numbers alone, say in at most two sentences (under 80 words) what most likely made "
                   "the year unusual, and say it is a reading of the numbers, not a reported fact.\n"
                   'Answer as a JSON object: {"summary": "..."}.')
    return ask_json(prompt, _note_shape(bool(pages)))


def quote_checks(reply, pages, sent, end: date):
    """Rules on a cited explanation: the page was one the model was given, the quote is on it (normalised), long
    enough to mean something, and the report is for that year. [{name, pass, detail}]."""
    page, quote = reply.get("page"), norm(reply.get("quote") or "")
    on = 1 <= page <= len(pages) and any(quote in norm(t) for t in pages[page - 1]) if isinstance(page, int) else False
    n = mentions_year(pages, end)
    return [
        {"name": "Page was read", "pass": page in sent,
         "detail": f"Page {page} was among the pages sent ({', '.join(map(str, sent))})." if page in sent
         else f"Page {page} wasn't among the pages sent ({', '.join(map(str, sent))})."},
        {"name": "Quote is on the page", "pass": on,
         "detail": f"The quote occurs on page {page}." if on
         else f"The quote doesn't occur on page {page}, so the explanation is rejected."},
        {"name": "Quote long enough", "pass": len(quote.split()) >= 5,
         "detail": f"{len(quote.split())} words (at least 5)."},
        {"name": "Report for the year", "pass": n >= 3,
         "detail": f"{n} pages name the year." + ("" if n >= 3 else " Is this the right year's report?")},
    ]
