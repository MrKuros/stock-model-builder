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

from model import _cr  # Rs crore with Indian grouping (ai may use model; model never imports ai)

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


# ---------- annual-report notes (3.3): rules pick the pages per topic, the LLM extracts, rules check every value ----------

# topic: (title, what to extract, words that point at its page (word, weight); a page needs a word of weight >= 3)
TOPICS = {
    "segments": ("Segment revenue", "the revenue from operations of each reportable business segment for the year "
                 "(external revenue; not geographies, not segment results, not the total)",
                 (("segment information", 4), ("operating segment", 3), ("reportable segment", 3),
                  ("segment revenue", 3), ("segment result", 3), ("revenue from operations", 1))),
    "maturity": ("Debt maturity", "the borrowings (and lease liabilities, if the table includes them) falling due in "
                 "each period as at the year end, one item per period (within 1 year, 1-5 years, after 5 years...)",
                 (("contractual maturities", 4), ("maturity profile", 4), ("maturity analysis", 4),
                  ("liquidity risk", 3), ("repayment", 1), ("borrowings", 1), ("lease liabilities", 1))),
    "capex": ("Capex", "from the cash flow statement for the year: purchase of property, plant and equipment "
              "(including capital work in progress) and, if shown on its own line, purchase of intangible assets",
              (("purchase of property, plant", 4), ("acquisition of property, plant", 4),
               ("cash flows from investing activities", 3), ("cash flow from investing activities", 3),
               ("purchase of intangible", 2))),
    "contingent": ("Contingent liabilities", "each contingent liability as at the year end (claims not acknowledged "
                   "as debt, tax demands, guarantees...), not commitments",
                   (("contingent liabilities", 4), ("acknowledged as debt", 4), ("commitments and contingencies", 4),
                    ("contingent liability", 3), ("contingencies", 3), ("guarantees", 1))),
    "related": ("Related-party transactions", "the largest related-party transactions of the year, at most 8: label "
                "each with the party (or group of parties) and the nature, e.g. 'Holding company: dividend paid'",
                (("related party", 3), ("related parties", 3), ("key management personnel", 2),
                 ("transactions with", 1))),
}
TOPIC_PAGES = 3  # ponytail: the 3 best pages per topic, cut to 8k characters; a missed note means attach + read again
UNITS = {"crore": 1.0, "lakh": 0.01, "million": 0.1, "billion": 100.0, "thousand": 1e-4, "rupees": 1e-7}
UNIT_WORDS = {"crore": ("crore", " cr"), "lakh": ("lakh", "lac"), "million": ("million", " mn"),
              "billion": ("billion", " bn"), "thousand": ("thousand", "'000", "000s")}
TIE = {"segments": 0.02, "maturity": 0.05, "capex": 0.02}  # sums agree with the statements within these


def pick_topic_pages(pages, topic, end: date):
    """Page numbers (1-based) of up to 3 pages for the topic, best first: word hits, then the consolidated notes
    (Export's figures are consolidated) and the year. A page needs a strong word, not just the year."""
    words, yr, scored = TOPICS[topic][2], year_re(end), []
    for i, (raw, _) in enumerate(pages):
        t = norm(raw)
        if not any(w in t for w, wt in words if wt >= 3):
            continue
        hits = sum(min(t.count(w), 5) * wt for w, wt in words)
        group = 3 * ("consolidated" in t) - 3 * ("standalone financial statements" in t or "standalone statement" in t)
        scored.append((hits + group + min(len(yr.findall(t)), 3), -i))
    return [-i + 1 for _, i in sorted(scored, reverse=True)[:TOPIC_PAGES]]


def page_text(page):
    """What the model reads of a page: the -layout text (table rows stay on one line), runs of spaces cut to two."""
    return re.sub(r"[ \t]{3,}", "  ", page[1])[:MAX_PAGE_CHARS]


def note_prompt(topic, year, end: date, pages):
    """The prompt for one topic, `pages` [(page number, text)]. Also used, without a call, to show its size."""
    title, what, _ = TOPICS[topic]
    text = "\n\n".join(f"=== PAGE {n} ===\n{t}" for n, t in pages)
    return (f"Pages from an Indian listed company's annual report for {year} (the year to {end:%d %B %Y}); only "
            f"these were read:\n{text}\n\n"
            f"Extract {what}. Use the consolidated figures when the report has both, and the column for the year to "
            f"{end:%d %B %Y}, not the previous year. For every item give the amount exactly as printed (a number, "
            "in the report's unit), the page number it is on, and a quote copied character for character from that "
            "page that contains the amount (the table row or sentence, 5 to 40 words). Give the unit the amounts are "
            'in: "crore", "lakh", "million", "billion", "thousand" or "rupees". Never convert, add up or estimate; '
            'if the pages don\'t show it, answer {"found": false}.\n'
            'Answer as a JSON object: {"found": true, "unit": "crore", "items": [{"label": "...", "amount": 123.4, '
            '"page": 12, "quote": "..."}]}.')


def note_shape(v):
    if not isinstance(v, dict) or not isinstance(v.get("found", True), bool):
        return 'expected {"found": true, "unit": ..., "items": [...]} or {"found": false}'
    if v.get("found") is False:
        return None
    if v.get("unit") not in UNITS:
        return f'"unit" must be one of {", ".join(UNITS)}'
    items = v.get("items")
    if not isinstance(items, list) or not items or len(items) > 20:
        return '"items" must be a list of 1 to 20 items'
    for x in items:
        if not (isinstance(x, dict) and isinstance(x.get("label"), str) and isinstance(x.get("page"), int)
                and isinstance(x.get("quote"), str) and isinstance(x.get("amount"), (int, float, str))):
            return 'each item must be {"label": string, "amount": number, "page": number, "quote": string}'
    return None


def extract_note(topic, year, end: date, pages):
    """{found, unit, items: [{label, amount, page, quote}]} for the topic from `pages` [(page number, text)]."""
    return ask_json(note_prompt(topic, year, end, pages), note_shape)


def amount(v):
    """A printed amount as a float: 1,64,177 / (34) / -34 / 2,719.50; None when it doesn't parse."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if abs(v) < 1e15 else None
    s = str(v).strip().replace(",", "").replace(" ", "")
    neg = s.startswith("(") and s.endswith(")")
    try:
        x = float(s.strip("()"))
    except ValueError:
        return None
    return -x if neg else x


def in_quote(x, quote):
    """The amount, as printed, occurs in the quote (Indian or Western grouping, brackets for negatives)."""
    nums = [amount(n) for n in re.findall(r"\d[\d,]*(?:\.\d+)?", quote)]
    return any(n is not None and abs(n - abs(x)) <= 0.005 + 1e-9 * abs(x) for n in nums)


def note_checks(topic, reply, pages, sent, end: date, against=None):
    """Rules on an extracted note: every item's page was sent, its quote is on that page, its amount parses and is in
    its quote, the unit is printed on a cited page, the report is for the year, and the sum ties to one of `against`
    [(label, Rs crore)] where the topic has a tie (TIE). Returns (rows in Rs crore, total, checks)."""
    unit, items = reply["unit"], reply["items"]
    rows, bad_page, bad_quote, bad_num = [], [], [], []
    for x in items:
        page, quote, v = x["page"], norm(x["quote"]), amount(x["amount"])
        on = 1 <= page <= len(pages) and any(quote in norm(t) for t in pages[page - 1])
        if page not in sent:
            bad_page.append(x["label"])
        if not on or len(quote.split()) < 3:
            bad_quote.append(x["label"])
        if v is None or not in_quote(v, x["quote"]):
            bad_num.append(x["label"])
        if v is not None and topic != "segments":
            v = abs(v)  # capex, debt due, claims and transactions are sizes; a cash outflow prints in brackets
        rows.append({"label": x["label"].strip()[:120], "amount": None if v is None else v * UNITS[unit], "raw": x["amount"],
                     "page": page, "quote": x["quote"].strip()[:400]})
    cited = {x["page"] for x in items if 1 <= x["page"] <= len(pages)}
    unit_seen = (not any(w in norm(pages[p - 1][0]) for p in cited for ws in UNIT_WORDS.values() for w in ws)
                 if unit == "rupees" else any(w in norm(pages[p - 1][0]) for p in cited for w in UNIT_WORDS[unit]))
    n_items, yrs = len(items), mentions_year(pages, end)
    what = lambda bad: ", ".join(bad[:4]) + (f" and {len(bad) - 4} more" if len(bad) > 4 else "")  # noqa: E731
    total = sum(r["amount"] for r in rows if r["amount"] is not None)
    checks = [
        {"name": "Pages were read", "pass": not bad_page,
         "detail": f"Every item cites one of the pages sent ({', '.join(map(str, sent))})." if not bad_page
         else f"{what(bad_page)} cite a page that wasn't sent ({', '.join(map(str, sent))})."},
        {"name": "Quotes are on their pages", "pass": not bad_quote,
         "detail": ("The quote occurs on the cited page." if n_items == 1 else f"All {n_items} quotes occur on the cited pages.") if not bad_quote
         else f"The quote for {what(bad_quote)} doesn't occur on its page, so the note is rejected."},
        {"name": "Numbers are in their quotes", "pass": not bad_num,
         "detail": ("The amount parses and appears in its quote." if n_items == 1 else f"All {n_items} amounts parse and appear in their quotes.") if not bad_num
         else f"The amount for {what(bad_num)} doesn't parse or isn't in its quote."},
        {"name": "Unit", "pass": unit_seen,
         "detail": f"Amounts in {unit}, converted to Rs crore by rules (x {UNITS[unit]:g})."
         + ("" if unit_seen else f" But no cited page says {unit}.")},
        {"name": "Report for the year", "pass": yrs >= 3,
         "detail": f"{yrs} pages name the year." + ("" if yrs >= 3 else " Is this the right year's report?")},
    ]
    if topic in TIE:
        tol, cands = TIE[topic], [(k, v) for k, v in against or () if v]
        if not cands:
            checks.append({"name": "Ties to the statements", "pass": None,
                           "detail": "No cash-flow capex from an XBRL filing for this year to compare with."
                           if topic == "capex" else "Nothing to compare with for this year."})
        else:
            k, v = min(cands, key=lambda c: abs(total / c[1] - 1))  # the closest (borrowings with or without leases)
            gap = total / v - 1
            checks.append({"name": "Ties to the statements", "pass": abs(gap) <= tol,
                           "detail": f"Sum {_cr(total)} vs {k} {_cr(v)}: {gap:+.1%} (within {tol:.0%} needed)."})
    return rows, total, checks
