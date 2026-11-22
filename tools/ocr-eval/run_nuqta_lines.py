"""Read the sampled pages line by line with Nuqta: image-processing rows plus a
Nuqta reading of each row, so every line of text comes with its exact box.

    .venv/bin/python run_nuqta_lines.py

Writes data/lines/nuqta-lines/<file_id>.json ({"lines":[{"text","bbox"}]}),
the joined text to data/out/nuqta-lines/<file_id>.md (so score.py rates its
text too), and overlays to data/lines/overlay/nuqta-lines/.
"""
import json, os, time

from PIL import Image
from nuqta import OCR, read_lines

from lines_cv import draw

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
MODEL = "SalahALHaismawi/Nuqta-Arabic-OCR-4B"

jdir = os.path.join(DATA, "lines", "nuqta-lines")
tdir = os.path.join(DATA, "out", "nuqta-lines")
os.makedirs(jdir, exist_ok=True)
os.makedirs(tdir, exist_ok=True)
rows = json.load(open(os.path.join(DATA, "sample.json")))
todo = [r for r in rows if not os.path.exists(os.path.join(jdir, f"{r['file_id']}.json"))]
ocr = OCR(MODEL, backend="transformers")
for i, r in enumerate(todo, 1):
    fid = r["file_id"]
    path = os.path.join(DATA, "pages", f"{fid}.jpg")
    t0 = time.time()
    page = read_lines(ocr, [path])[0].pages[0]
    secs = round(time.time() - t0, 1)
    lines = [{"text": l.text, "bbox": list(l.bbox)} for l in page.lines]
    json.dump({"lines": lines, "secs": secs}, open(os.path.join(jdir, f"{fid}.json"), "w"), ensure_ascii=False)
    open(os.path.join(tdir, f"{fid}.md"), "w").write(page.text + "\n")
    with open(os.path.join(tdir, "usage.jsonl"), "a") as f:
        f.write(json.dumps({"file_id": fid, "secs": secs}) + "\n")
    draw(Image.open(path), [l["bbox"] for l in lines],
         os.path.join(DATA, "lines", "overlay", "nuqta-lines", f"{fid}.jpg"), color=(20, 150, 60))
    print(f"[{i}/{len(todo)}] {fid} {len(lines)} lines {secs}s", flush=True)
