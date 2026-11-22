"""Run Nuqta-Arabic-OCR locally over the sampled pages.

    .venv/bin/python run_nuqta.py [--model SalahALHaismawi/Nuqta-Arabic-OCR-4B]

Writes data/out/<model-slug>/<file_id>.md and usage.jsonl (seconds per page).
Nuqta outputs plain text / Markdown in reading order; it does not follow our
prompt (no running header split, حاشية heading or ruby), so score it on text.
"""
import argparse, json, os, time

from nuqta import OCR

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="SalahALHaismawi/Nuqta-Arabic-OCR-4B")
ap.add_argument("--backend", default="transformers")
a = ap.parse_args()

slug = "nuqta-" + a.model.split("/")[-1].lower()
outdir = os.path.join(DATA, "out", slug)
os.makedirs(outdir, exist_ok=True)
rows = json.load(open(os.path.join(DATA, "sample.json")))
todo = [r for r in rows if not os.path.exists(os.path.join(outdir, f"{r['file_id']}.md"))]
print(f"{len(todo)} pages to read", flush=True)

t_load = time.time()
ocr = OCR(a.model, backend=a.backend)
print(f"model loaded in {time.time() - t_load:.0f}s", flush=True)

for i, row in enumerate(todo, 1):
    fid = row["file_id"]
    t0 = time.time()
    result = ocr.read(os.path.join(DATA, "pages", f"{fid}.jpg"))
    secs = round(time.time() - t0, 1)
    open(os.path.join(outdir, f"{fid}.md"), "w").write(result.text.strip() + "\n")
    with open(os.path.join(outdir, "usage.jsonl"), "a") as f:
        f.write(json.dumps({"file_id": fid, "secs": secs}) + "\n")
    print(f"[{i}/{len(todo)}] {fid} {secs}s", flush=True)
