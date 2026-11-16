"""Work out each page's printed page number and where it sits (top or bottom).

Gemini's transcription keeps the running header as the first block (before the
first `---`) and a lone footer number as the last line, so the printed number
can be read from the text. Typed page numbers can be offset from the printed
ones for a whole book (e.g. typed = printed + 1), so each book's offset is the
most common difference between typed and transcribed numbers.

Writes data/labels.json: {name: {"book", "top", "bottom"}} where top/bottom are
the digit strings printed in that strip ("" = no number), or the page is left
out when its label can't be trusted.
"""

import collections
import json
import re

DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
rows = json.load(open("data/pages.json"))


def numbers(s: str) -> list[int]:
    return [int(x) for x in re.findall(r"\d+", s.translate(DIGITS))]


def header(text: str) -> str:
    head, sep, _ = text.partition("---")
    return head if sep and len(head) < 300 else ""


def footer(text: str) -> str:
    lines = [l.strip() for l in text.strip().splitlines() if l.strip()]
    last = lines[-1] if lines else ""
    # A footer page number stands alone on the last line, maybe in brackets.
    return last if re.fullmatch(r"[\(\[]?\s*[\d٠-٩۰-۹]+\s*[\)\]]?", last) else ""


offsets: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
for r in rows:
    for n in numbers(header(r["text"])) + numbers(footer(r["text"])):
        if r["typed"] is not None:
            offsets[r["book"]][r["typed"] - n] += 1
# Most common offset per book; on a tie prefer the smallest (usually 0).
book_offset = {
    b: max(c.items(), key=lambda kv: (kv[1], -abs(kv[0])))[0] for b, c in offsets.items()
}

labels, why = {}, collections.Counter()
for r in rows:
    off = book_offset.get(r["book"])
    if r["typed"] is None or off is None:
        why["no typed number or book offset"] += 1
        continue
    printed = r["typed"] - off
    top, bottom = numbers(header(r["text"])), numbers(footer(r["text"]))
    if printed in top:
        labels[r["name"]] = {"book": r["book"], "top": str(printed), "bottom": ""}
        why["top"] += 1
    elif printed in bottom:
        labels[r["name"]] = {"book": r["book"], "top": "", "bottom": str(printed)}
        why["bottom"] += 1
    elif not top and not bottom:
        # No number transcribed anywhere: a chapter opening, title page, or a
        # number Gemini skipped. Can't tell which, so leave it out.
        why["no number transcribed"] += 1
    else:
        why["transcribed number doesn't match typed"] += 1

json.dump(labels, open("data/labels.json", "w"), ensure_ascii=False)
print("book offsets (typed - printed):", {b[:20]: o for b, o in book_offset.items() if o})
print(dict(why))
