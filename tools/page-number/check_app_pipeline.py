"""Compare the page-number reader through the training pipeline and through
the app's pipeline on the same held-out pages.

The app resizes with Android's bilinear scaling (no antialiasing), re-encodes
as JPEG, and decodes to grayscale before cutting strips; training used
antialiased PIL resizing. This measures what that difference costs, and
whether resizing in halving steps (what the app can do to approximate
antialiasing) wins it back. "app native" emulates the native decoder
(modules/page-pixels): power-of-two sampled decode (box reduce), plain
bilinear to the exact size, grayscale, no JPEG round trip.

Usage: python check_app_pipeline.py [model.pt]   (held-out = every 5th page)
"""

import io
import json
import os
import sys

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

from model_def import H, STRIP, W, PageNumberNet, decode

SRC = sys.argv[1] if len(sys.argv) > 1 else "data/pagenum_pagesplit.pt"
PAGE_W = 768

labels = json.load(open("data/labels.json"))
names = sorted(n for n in labels if os.path.exists(f"../orientation/data/pages/{n}"))
test = [n for i, n in enumerate(names) if i % 5 == 0]

model = PageNumberNet()
model.load_state_dict(torch.load(SRC, map_location="cpu"))
model.eval()


def resize_plain(a: np.ndarray, w: int, h: int) -> np.ndarray:
    """Bilinear without antialiasing, like Android's Bitmap scaling."""
    t = torch.from_numpy(a).float()[None, None]
    return F.interpolate(t, size=(h, w), mode="bilinear", align_corners=False, antialias=False)[0, 0].round().clamp(0, 255).byte().numpy()


def resize_halving(a: np.ndarray, w: int, h: int) -> np.ndarray:
    """Halve repeatedly while more than 2x too big, then one plain resize."""
    while a.shape[1] >= 2 * w:
        a = resize_plain(a, a.shape[1] // 2, a.shape[0] // 2)
    return resize_plain(a, w, h)


def native_gray(path: str, w: int, h: int) -> np.ndarray:
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    f = 1
    while im.width // (f * 2) >= w and im.height // (f * 2) >= h:
        f *= 2
    rgb = np.asarray(im.reduce(f) if f > 1 else im)
    chans = np.stack([resize_plain(np.ascontiguousarray(rgb[..., c]), w, h) for c in range(3)], -1)
    return np.asarray(Image.fromarray(chans).convert("L"))


def jpeg(a: np.ndarray, q: int = 90) -> np.ndarray:
    buf = io.BytesIO()
    Image.fromarray(a).save(buf, "JPEG", quality=q)
    return np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("L"))


def strips(page: np.ndarray) -> np.ndarray:
    h = round(page.shape[0] * STRIP)
    return np.stack([resize_plain(page[:h], W, H), resize_plain(page[-h:], W, H)])


def read(page: np.ndarray) -> tuple[str, float]:
    with torch.no_grad():
        p = model(torch.from_numpy(strips(page))).numpy()
    (t, tc), (b, bc) = decode(p[0]), decode(p[1])
    if t and (not b or tc >= bc):
        return t, tc
    if b:
        return b, bc
    return "", max(tc, bc)


results = {"training": [], "app plain": [], "app halving": [], "app native": []}
for n in test:
    im = ImageOps.exif_transpose(Image.open(f"../orientation/data/pages/{n}")).convert("L")
    w, h = im.size
    ph = round(h * PAGE_W / w)
    truth = labels[n]["top"] or labels[n]["bottom"]
    results["training"].append((truth, *read(np.asarray(im.resize((PAGE_W, ph), Image.BILINEAR)))))
    # The app resizes the colour image, saves JPEG q90, then converts to gray.
    rgb = np.asarray(ImageOps.exif_transpose(Image.open(f"../orientation/data/pages/{n}")).convert("RGB"))
    for key, fn in (("app plain", resize_plain), ("app halving", resize_halving)):
        chans = np.stack([fn(rgb[..., c], PAGE_W, ph) for c in range(3)], -1)
        buf = io.BytesIO()
        Image.fromarray(chans).save(buf, "JPEG", quality=90)
        gray = np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("L"))
        results[key].append((truth, *read(gray)))
    results["app native"].append((truth, *read(native_gray(f"../orientation/data/pages/{n}", PAGE_W, ph))))

for key, rs in results.items():
    top = sum(t == r for t, r, _ in rs) / len(rs)
    print(f"{key:12} top guess {top:6.1%}")
    for cut in (0.9, 0.95, 0.97, 0.99):
        acc = [(t, r) for t, r, c in rs if r and c >= cut]
        wrong = [(t, r) for t, r in acc if t != r]
        print(f"   cutoff {cut}: filled {len(acc) / len(rs):6.1%}, wrong {len(wrong)} {wrong}")
