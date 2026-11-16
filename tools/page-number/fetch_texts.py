"""Download each page's transcription and typed page number, plus any page
image the orientation tool hasn't fetched yet.

Needs OCR_URL and OCR_KEY in the environment. Writes data/pages.json:
[{name, book, typed, text}], and images into ../orientation/data/pages/.
"""

import json
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = os.environ["OCR_URL"].rstrip("/")
H = {"Authorization": f"Bearer {os.environ['OCR_KEY']}", "User-Agent": "page-number-tool"}
IMAGES = "../orientation/data/pages"


def get(path: str, raw: bool = False):
    req = urllib.request.Request(BASE + path, headers=H)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read() if raw else json.load(r)


os.makedirs("data", exist_ok=True)
os.makedirs(IMAGES, exist_ok=True)
books = get("/api/books")
books = books.get("books", books) if isinstance(books, dict) else books
jobs = []
for b in books:
    st = get(f"/api/books/{b['id']}/status")
    for f in st.get("files", st) if isinstance(st, dict) else st:
        if f.get("state") == "done":
            jobs.append((b, f))


def fetch(job):
    b, f = job
    name = f"{b['id']}_{f['file_id']}.jpg"
    for _ in range(3):
        try:
            text = get(f"/api/books/{b['id']}/files/{f['file_id']}/text", raw=True).decode()
            img = f"{IMAGES}/{name}"
            if not os.path.exists(img):
                data = get(f"/api/books/{b['id']}/files/{f['file_id']}/image", raw=True)
                open(img + ".part", "wb").write(data)
                os.rename(img + ".part", img)
            return {"name": name, "book": b["title"], "typed": f.get("page_number"), "text": text}
        except Exception as e:  # noqa: BLE001
            err = e
    print("fail", name, err)
    return None


with ThreadPoolExecutor(8) as ex:
    rows = [r for r in ex.map(fetch, jobs) if r]
json.dump(rows, open("data/pages.json", "w"), ensure_ascii=False)
print(f"{len(rows)} of {len(jobs)} pages")
