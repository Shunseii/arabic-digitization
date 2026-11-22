"""Find printed text rows with image processing (no model) and draw overlays.

    .venv/bin/python lines_cv.py

Uses Nuqta's projection-profile segmenter (Otsu + deskew + horizontal profile).
Writes data/lines/cv/<file_id>.json ({"width","height","rows":[[x0,y0,x1,y1],...]})
and data/lines/overlay/cv/<file_id>.jpg for eyeballing. These rows are the
reference the model-predicted rows are scored against (score_lines.py).
"""
import json, os

from PIL import Image, ImageDraw
from nuqta.layout import map_box, segment_page

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def draw(img, boxes, path, color=(230, 40, 40)):
    im = img.convert("RGB").copy()
    d = ImageDraw.Draw(im)
    w = max(3, im.width // 400)
    for i, (x0, y0, x1, y1) in enumerate(boxes, 1):
        d.rectangle([x0, y0, x1, y1], outline=color, width=w)
        d.text((x0 + 4, y0 + 2), str(i), fill=color)
    im.thumbnail((1400, 1400))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, quality=80)


if __name__ == "__main__":
    os.makedirs(os.path.join(DATA, "lines", "cv"), exist_ok=True)
    rows = json.load(open(os.path.join(DATA, "sample.json")))
    for r in rows:
        fid = r["file_id"]
        img = Image.open(os.path.join(DATA, "pages", f"{fid}.jpg"))
        seg = segment_page(img)
        boxes = [list(map_box(b, seg.matrix, seg.size)) for b in seg.boxes]
        json.dump({"width": img.width, "height": img.height, "rows": boxes},
                  open(os.path.join(DATA, "lines", "cv", f"{fid}.json"), "w"))
        draw(img, boxes, os.path.join(DATA, "lines", "overlay", "cv", f"{fid}.jpg"))
        print(fid, r["book_title"], len(boxes), "rows")
