"""Score an exported model through the same steps the app takes.

App: resize the page so its short side is 533 px, re-encode as JPEG (q 0.9),
decode to grayscale, cut five 320 px crops, run the model, rotate if the top
probability is >= THRESHOLD. Uses the held-out works from train.py.

"native" emulates the native decoder (modules/page-pixels): a power-of-two
sampled JPEG decode (approximated by a box reduce), plain bilinear scaling to
the exact size, then grayscale, with no JPEG round trip.
"""

import io
import json
import sys

import numpy as np
import onnxruntime as ort
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

from train_split import is_test

SHORT, CROP, THRESHOLD = 533, 320, 0.8
POSITIONS = [(0.5, 0.5), (0.3, 0.3), (0.3, 0.7), (0.7, 0.3), (0.7, 0.7)]

ort.set_default_logger_severity(3)
sess = ort.InferenceSession(sys.argv[1] if len(sys.argv) > 1 else "../../apps/mobile/assets/models/orientation.onnx")
meta = json.load(open("data/meta.json"))
test = sorted(n for n in meta if is_test(meta[n]))


def resize_plain(a: np.ndarray, w: int, h: int) -> np.ndarray:
    """Bilinear without antialiasing, like Android's Bitmap scaling."""
    t = torch.from_numpy(a).float()[None, None]
    return F.interpolate(t, size=(h, w), mode="bilinear", align_corners=False, antialias=False)[0, 0].round().clamp(0, 255).byte().numpy()


def native_gray(im: Image.Image, w: int, h: int) -> np.ndarray:
    f = 1
    while im.width // (f * 2) >= w and im.height // (f * 2) >= h:
        f *= 2
    rgb = np.asarray(im.reduce(f) if f > 1 else im)
    chans = np.stack([resize_plain(np.ascontiguousarray(rgb[..., c]), w, h) for c in range(3)], -1)
    return np.asarray(Image.fromarray(chans).convert("L"))


def app_gray(im: Image.Image, method: str) -> np.ndarray:
    w, h = im.size
    s = SHORT / min(w, h)
    size = (round(w * s), round(h * s))
    if method == "native":
        return native_gray(im, *size)
    im = im.resize(size, Image.BILINEAR)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    return np.asarray(Image.open(buf).convert("L"))


def app_crops(im: Image.Image, method: str = "app") -> np.ndarray:
    a = app_gray(im, method)
    h, w = a.shape
    out = []
    for fy, fx in POSITIONS:
        y = int(np.clip(round(fy * h - CROP / 2), 0, h - CROP))
        x = int(np.clip(round(fx * w - CROP / 2), 0, w - CROP))
        out.append(a[y : y + CROP, x : x + CROP])
    return np.stack(out)


for method in ("app", "native"):
    right = wrong = skipped = 0
    wrong_conf = []
    for n in test:
        page = ImageOps.exif_transpose(Image.open(f"data/pages/{n}")).convert("RGB")
        for k in range(4):
            # Turn the upright page k*90 counter-clockwise, as the scanner might.
            p = sess.run(None, {"crops": app_crops(page.rotate(90 * k, expand=True), method)})[0]
            top = int(p.argmax())
            if p[top] < THRESHOLD:
                skipped += 1
            elif top == k:
                right += 1
            else:
                wrong += 1
                wrong_conf.append(float(p[top]))
    total = len(test) * 4
    print(f"{method:6} {total} cases: correct {right} ({right / total:.1%}), left as scanned {skipped}, wrongly rotated {wrong}")
    print("       confidence of wrong calls:", [round(c, 2) for c in wrong_conf])
