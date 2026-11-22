"""Re-transcribe a set of pages with the prompt now in apps/api/src/ocr.ts,
straight against Gemini (production model and settings), and compare the
ruby glosses with what is stored.

    python3 run_prompt_test.py <sample.json> <outdir>

<sample.json> rows: file_id, book_id, page_number, ocr_instructions.
Writes <outdir>/old/<file_id>.md (stored text), <outdir>/new/<file_id>.md and
prints, per page, the glosses whose base word changed.
Key: GOOGLE_API_KEY from apps/api/.dev.vars.
"""
import base64, json, os, re, sys, urllib.request  # noqa: E401
from concurrent.futures import ThreadPoolExecutor

from fetch import BASE, H
from run_cloud import mime, system_prompt, with_book_notes
from run_lines_cloud import google_key

MODEL = "gemini-3.1-pro-preview"
RUBY = re.compile(r"<ruby>(.*?)<rt>(.*?)</rt></ruby>", re.S)


def get(path):
    return urllib.request.urlopen(urllib.request.Request(BASE.rstrip("/") + path, headers=H), timeout=60).read()


def transcribe(img_path, prompt, key):
    body = {"systemInstruction": {"parts": [{"text": prompt}]},
            "contents": [{"role": "user", "parts": [
                {"inlineData": {"mimeType": mime(img_path), "data": base64.b64encode(open(img_path, "rb").read()).decode()}},
                {"text": "Transcribe this page."}]}],
            "generationConfig": {"maxOutputTokens": 16000, "thinkingConfig": {"thinkingLevel": os.environ.get("THINKING", "low")}}}
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
        data=json.dumps(body).encode(), method="POST",
        headers={"x-goog-api-key": key, "Content-Type": "application/json"})
    data = json.load(urllib.request.urlopen(req, timeout=300))
    parts = data["candidates"][0]["content"]["parts"]
    return "".join(p.get("text", "") for p in parts if not p.get("thought")).strip() + "\n"


def main(sample, outdir):
    rows = json.load(open(sample))
    key = google_key()
    base = system_prompt()
    for d in ("old", "new", "pages"):
        os.makedirs(os.path.join(outdir, d), exist_ok=True)

    def one(r):
        fid, bid = r["file_id"], r["book_id"]
        img = os.path.join(outdir, "pages", f"{fid}.jpg")
        old = os.path.join(outdir, "old", f"{fid}.md")
        new = os.path.join(outdir, "new", f"{fid}.md")
        if not os.path.exists(img):
            open(img, "wb").write(get(f"/api/books/{bid}/files/{fid}/image"))
        if not os.path.exists(old):
            open(old, "wb").write(get(f"/api/books/{bid}/files/{fid}/text"))
        if not os.path.exists(new):
            try:
                open(new, "w").write(transcribe(img, with_book_notes(base, r.get("ocr_instructions")), key))
            except Exception as e:  # report and keep going
                return fid, f"FAIL {e!r}"[:200]
        return fid, "ok"

    with ThreadPoolExecutor(4) as ex:
        status = dict(ex.map(one, rows))

    total_old = total_new = changed = 0
    for r in sorted(rows, key=lambda r: r.get("page_number") or 0):
        fid = r["file_id"]
        if status[fid] != "ok":
            print(r.get("page_number"), status[fid])
            continue
        o = {g.strip(): b.strip() for b, g in RUBY.findall(open(os.path.join(outdir, "old", f"{fid}.md")).read())}
        n = {g.strip(): b.strip() for b, g in RUBY.findall(open(os.path.join(outdir, "new", f"{fid}.md")).read())}
        total_old += len(o)
        total_new += len(n)
        diffs = [(g, o[g], n[g]) for g in o if g in n and o[g] != n[g]]
        changed += len(diffs)
        if diffs:
            print(f"p.{r.get('page_number')} {fid}")
            for g, a, b in diffs:
                print(f"   {g[:40]:40}  {a}  ->  {b}")
    print(f"glosses: stored {total_old}, new {total_new}, base word changed on {changed}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
