"""Reading and judging with a language model, provider-neutral and with no SDK: the shell command in LLM_CMD gets
the prompt on stdin and prints the reply on stdout. model.py never imports this module. Nothing returned here
becomes a number by itself: callers turn it into a proposal that rules check and the user approves."""
import json
import os
import shlex
import subprocess

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
