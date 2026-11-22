"""Second pass that re-attaches each ruby gloss to the word it explains, using
the scan (where the gloss is printed) and the meaning (what it can refer to).

    python3 fix_glosses.py <page.md> <scan.jpg> [--truth truth.json] [--runs N]

Prints each gloss's stored base and the pass's choice, and, with --truth
({"<gloss text>": "<correct base>"}), how many it gets right per run.
Key: GOOGLE_API_KEY from apps/api/.dev.vars.
"""
import argparse, base64, json, re, urllib.request  # noqa: E401

from run_cloud import mime
from run_lines_cloud import google_key

MODEL = "gemini-3.1-pro-preview"
RUBY = re.compile(r"<ruby>(.*?)<rt>(.*?)</rt></ruby>", re.S)

PROMPT = """You check interlinear glosses in a transcribed page of a classical Arabic book.

A gloss is small text printed just above or just below a main line, explaining
one word or short phrase of that line. The transcription below marks each
gloss as {gN: gloss text} at the place the transcriber guessed (the guess is
often a word or two off), or lists the glosses separately when no guess is
given. Using the page image, find the word each gloss really belongs to. Weigh two things together:

1. Position. An Arabic gloss begins at its RIGHT end; the word it explains is
   the main-line word directly against the gloss's right end. Glosses may sit
   above or below their line.
2. Meaning and grammar. Many glosses say what they refer to:
   - "عطف على X" sits on the word that is joined (معطوف) to X, not on X.
   - "أي X" explains a word, pronoun or phrase whose meaning or referent is X.
   - "ضمير الشأن" sits on a word carrying that pronoun (e.g. فإنه، أنه).
   - "الفاء ..." sits on a word that starts with that فاء.
   - "خبر ل..." / "حال من ..." / "متعلق ب..." sit on the خبر / حال / متعلق.
   A gloss that fits a word's meaning but is printed far from it does not
   belong to it; a word against the gloss's right end that the gloss cannot
   grammatically explain is also wrong. Find the word that satisfies both.

Return ONLY JSON:
{"glosses": [{"n": 1, "line": <the line number below>, "base": "<exact word(s) copied from that line, without punctuation>", "occurrence": <1 if the first time that text appears in the line, 2 if the second, ...>}]}
Include every gloss once."""


def numbered(md, blind=False):
    """Transcription lines with each ruby replaced by 'base {gN: gloss}', or,
    with blind, the plain lines plus a separate list of glosses (no placement)."""
    glosses, out = [], []
    lines = md.splitlines()
    for i, line in enumerate(lines, 1):
        def sub(m):
            glosses.append({"n": len(glosses) + 1, "line": i, "base": m.group(1).strip(), "gloss": m.group(2).strip()})
            return m.group(1) if blind else f"{m.group(1)} {{g{len(glosses)}: {m.group(2)}}}"
        out.append(f"{i}: {RUBY.sub(sub, line)}")
    text = "\n".join(out)
    if blind:
        text += "\n\nGlosses printed on this page (placement unknown):\n" + "\n".join(
            f"g{g['n']}: {g['gloss']}" for g in glosses)
    return text, glosses


def ask(md_numbered, img, key, thinking):
    body = {"systemInstruction": {"parts": [{"text": PROMPT}]},
            "contents": [{"role": "user", "parts": [
                {"inlineData": {"mimeType": mime(img), "data": base64.b64encode(open(img, "rb").read()).decode()}},
                {"text": md_numbered}]}],
            "generationConfig": {"maxOutputTokens": 16000, "responseMimeType": "application/json",
                                 "thinkingConfig": {"thinkingLevel": thinking}}}
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
        data=json.dumps(body).encode(), method="POST",
        headers={"x-goog-api-key": key, "Content-Type": "application/json"})
    data = json.load(urllib.request.urlopen(req, timeout=300))
    text = "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"] if not p.get("thought"))
    u = data.get("usageMetadata", {})
    return json.loads(text)["glosses"], u


def norm(s):
    return re.sub(r"[ً-ْٰـ،؛:.()\[\]«»\s\d٠-٩]", "", s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("md")
    ap.add_argument("img")
    ap.add_argument("--truth")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--thinking", default="high")
    ap.add_argument("--blind", action="store_true", help="don't show the transcriber's placement")
    a = ap.parse_args()
    md_n, glosses = numbered(open(a.md).read(), blind=a.blind)
    truth = {norm(k): norm(v) for k, v in json.load(open(a.truth)).items()} if a.truth else {}
    key = google_key()
    if truth:
        stored_ok = sum(truth.get(norm(g["gloss"])) == norm(g["base"]) for g in glosses)
        print(f"stored: {stored_ok}/{len(glosses)} right")
    for run in range(1, a.runs + 1):
        picks, usage = ask(md_n, a.img, key, a.thinking)
        by_n = {p["n"]: p for p in picks}
        ok = 0
        print(f"-- run {run} (in {usage.get('promptTokenCount')}, out {usage.get('candidatesTokenCount', 0) + usage.get('thoughtsTokenCount', 0)})")
        for g in glosses:
            p = by_n.get(g["n"], {})
            right = truth.get(norm(g["gloss"]))
            good = right is not None and norm(p.get("base", "")) == right
            ok += good
            mark = "" if right is None else (" ok" if good else f" WRONG (want {right})")
            print(f"   {g['gloss'][:34]:34} {g['base']:14} -> {p.get('base', '?')} #{p.get('occurrence', '?')}{mark}")
        if truth:
            print(f"   right: {ok}/{len(glosses)}")


if __name__ == "__main__":
    main()
