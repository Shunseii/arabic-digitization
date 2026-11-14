"""Download every stored page scan (all upright) into data/pages/ for training.

Needs OCR_URL and OCR_KEY (the API base URL and bearer key) in the environment.
"""
import json, os, urllib.request
from concurrent.futures import ThreadPoolExecutor
BASE = os.environ["OCR_URL"].rstrip("/")
H = {"Authorization": f"Bearer {os.environ['OCR_KEY']}", "User-Agent": "orientation-test"}
def get(path, raw=False):
    r = urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=60)
    return r.read() if raw else json.load(r)
os.makedirs("data/pages", exist_ok=True)
books = get("/api/books"); books = books.get("books", books) if isinstance(books, dict) else books
jobs, meta = [], {}
for b in books:
    st = get(f"/api/books/{b['id']}/status"); files = st.get("files", st) if isinstance(st, dict) else st
    for f in files:
        name = f"{b['id']}_{f['file_id']}.jpg"; meta[name] = b["title"]
        jobs.append((b["id"], f["file_id"], f"data/pages/{name}"))
json.dump(meta, open("data/meta.json", "w"), ensure_ascii=False)
def dl(j):
    bid, fid, out = j
    if os.path.exists(out): return 0
    for _ in range(3):
        try:
            open(out + ".part", "wb").write(get(f"/api/books/{bid}/files/{fid}/image", raw=True)); os.rename(out + ".part", out); return 1
        except Exception as e: err = e
    print("fail", out, err); return 0
with ThreadPoolExecutor(8) as ex: n = sum(ex.map(dl, jobs))
print("downloaded", n, "of", len(jobs))
