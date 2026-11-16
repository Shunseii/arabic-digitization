"""Synthetic page-number strips.

Real pages alone let the model memorise "this header means page 186" instead of
reading digits (each training book has one page per number). So half of each
batch is synthetic: a real strip with no page number, a margin band cleared,
and a running header or lone footer number drawn in it with a random number.
The number can't be guessed from the rest of the strip, so the model has to
read it.
"""

import json
import random
import re

import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = [
    "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansArabic-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoKufiArabic-Regular.ttf",
    "/home/shunsei-pop/.local/share/fonts/ScheherazadeNew-Regular.ttf",
    "/home/shunsei-pop/.local/share/fonts/ScheherazadeNew-Bold.ttf",
]
ARABIC = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")
PERSIAN = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")
_fonts: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    key = (path, size)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(path, size, layout_engine=ImageFont.Layout.RAQM)
    return _fonts[key]


def header_titles(books: set[str], pages_json: str = "data/pages.json") -> list[str]:
    """Title phrases from real running headers of `books`, digits and brackets removed."""
    titles = set()
    for r in json.load(open(pages_json)):
        if r["book"] not in books:
            continue
        head, sep, _ = r["text"].partition("---")
        if not sep or len(head) > 300:
            continue
        clean = re.sub(r"[\d٠-٩۰-۹()\[\]،,:\-]+", " ", head)
        for part in re.split(r"\s{2,}|\n", clean):
            part = part.strip(" #*")
            if 2 <= len(part) <= 40:
                titles.add(part)
    return sorted(titles)


_cmaps: dict[str, set[int]] = {}


def renders(f: ImageFont.FreeTypeFont, text: str) -> bool:
    """False if the font has no glyph for some character (it would draw a box)."""
    if f.path not in _cmaps:
        _cmaps[f.path] = set(TTFont(f.path).getBestCmap())
    return all(ord(ch) in _cmaps[f.path] for ch in text if not ch.isspace())


def random_number() -> str:
    r = random.random()
    if r < 0.15:
        return str(random.randint(1, 9))
    if r < 0.55:
        return str(random.randint(10, 99))
    return str(random.randint(100, 999))


def styled(num: str) -> str:
    r = random.random()
    digits = num.translate(ARABIC) if r < 0.8 else num.translate(PERSIAN) if r < 0.9 else num
    if random.random() < 0.1:
        digits = f"({digits})"
    return digits


def frame(d, box, ink, w, margin, top, line_h):
    """Decorate the number: plain, boxed, rounded, bracketed onto a rule, or
    double-framed, with or without a rule across the strip."""
    x0, y0, x1, y1 = box
    pad = random.randint(3, 10)
    bx = (x0 - pad, y0 - pad, x1 + pad, y1 + pad)
    max_r = max(2, min(bx[2] - bx[0], bx[3] - bx[1]) // 3)
    width = random.randint(1, 3)
    style = random.random()
    rule_y = y0 + line_h if top else y0 - random.randint(4, 10)
    if style < 0.12:
        d.rectangle(bx, outline=ink, width=width)
    elif style < 0.24:
        d.rounded_rectangle(bx, radius=min(random.randint(4, 14), max_r), outline=ink, width=width)
    elif style < 0.36:
        # Number in a rounded bracket that sits on a rule running across the
        # page, as in الألفاظ الكتابية.
        d.rounded_rectangle(bx, radius=min(random.randint(6, 16), max_r), outline=ink, width=width)
        ry = bx[3]
        d.line([margin // 2, ry, w - margin // 2, ry], fill=ink, width=width)
        return
    elif style < 0.44:
        d.rectangle(bx, outline=ink, width=width)
        g = random.randint(3, 5)
        d.rectangle((bx[0] - g, bx[1] - g, bx[2] + g, bx[3] + g), outline=ink, width=1)
    elif style < 0.52:
        # Ornament: small diamonds either side of the number.
        r = random.randint(3, 6)
        cy = (y0 + y1) // 2
        for cx in (x0 - pad - 2 * r, x1 + pad + 2 * r):
            d.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], fill=ink)
    if random.random() < 0.45:
        d.line([margin // 2, rule_y, w - margin // 2, rule_y], fill=ink, width=width)


def make(bg: np.ndarray, titles: list[str], top: bool) -> tuple[np.ndarray, str]:
    """Draw a page number (and maybe a header) into a number-free strip."""
    h, w = bg.shape
    paper = int(np.percentile(bg, 90))
    ink = random.randint(10, 80)
    im = Image.fromarray(bg.copy())
    d = ImageDraw.Draw(im)

    size = random.randint(int(h * 0.11), int(h * 0.19))
    num_font = font(random.choice(FONTS), size)
    title_font = font(random.choice(FONTS), max(10, size + random.randint(-6, 4)))
    num = random_number()
    shown = styled(num)
    while not renders(num_font, shown):
        num_font = font(random.choice(FONTS), size)

    nb = d.textbbox((0, 0), shown, font=num_font, direction="ltr")
    nw, nh = nb[2] - nb[0], nb[3] - nb[1]
    line_h = int(size * 1.6)
    if top:
        y0 = random.randint(int(h * 0.02), int(h * 0.35))
        d.rectangle([0, 0, w, y0 + line_h + random.randint(2, 12)], fill=paper)
    else:
        y0 = random.randint(int(h * 0.45), int(h - line_h - 2))
        d.rectangle([0, y0 - random.randint(2, 12), w, h], fill=paper)

    margin = random.randint(int(w * 0.04), int(w * 0.14))
    layout = random.random()
    if top and layout < 0.6:
        # Running header: titles at both ends, number in the middle.
        nx = (w - nw) // 2 + random.randint(-int(w * 0.05), int(w * 0.05))
        for side in ("right", "left"):
            if random.random() < 0.85:
                t = random.choice(titles)
                tb = d.textbbox((0, 0), t, font=title_font, direction="rtl", language="ar")
                tw = tb[2] - tb[0]
                if tw < w * 0.38 and renders(title_font, t):
                    tx = w - margin - tw if side == "right" else margin
                    d.text((tx - tb[0], y0 - tb[1]), t, font=title_font, fill=ink, direction="rtl", language="ar")
    elif top and layout < 0.85:
        # Number at an outer corner, a title on the other side.
        corner_right = random.random() < 0.5
        nx = w - margin - nw if corner_right else margin
        if random.random() < 0.8:
            t = random.choice(titles)
            tb = d.textbbox((0, 0), t, font=title_font, direction="rtl", language="ar")
            tw = tb[2] - tb[0]
            if tw < w * 0.6 and renders(title_font, t):
                tx = margin if corner_right else w - margin - tw
                d.text((tx - tb[0], y0 - tb[1]), t, font=title_font, fill=ink, direction="rtl", language="ar")
    else:
        # Lone number, centred or near a corner.
        nx = (w - nw) // 2 if random.random() < 0.7 else (margin if random.random() < 0.5 else w - margin - nw)
        nx += random.randint(-int(w * 0.03), int(w * 0.03))

    d.text((nx - nb[0], y0 - nb[1]), shown, font=num_font, fill=ink, direction="ltr")
    frame(d, (nx, y0, nx + nw, y0 + nh), ink, w, margin, top, line_h)

    if random.random() < 0.3:
        im = im.filter(ImageFilter.GaussianBlur(random.uniform(0.3, 1.0)))
    return np.asarray(im), num
