#!/usr/bin/env python3
"""Genera una imagen de prueba (formato vertical, 1080x1920) con un logo
placeholder del "Coro Rodal", pensada para probar la función de imagen de
fondo por evento de Pase Único. No es un logo real de ninguna organización:
es una composición simple armada con Pillow para tener algo con lo que
probar la subida/recorte/composición del QR.
"""

import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1920
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "sample-coro-rodal.jpg")

ACCENT = (106, 66, 224)       # --accent
ACCENT_DARK = (27, 23, 48)    # --paper dark
GOLD = (201, 168, 90)
INK = (241, 238, 251)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def build_background():
    img = Image.new("RGB", (W, H))
    px = img.load()
    top = (36, 27, 74)
    bottom = (14, 11, 28)
    for y in range(H):
        t = y / (H - 1)
        # slight easing so the gradient feels less linear/flat
        t = t ** 0.85
        color = lerp(top, bottom, t)
        for x in range(0, W, 1):
            px[x, y] = color
    return img


def add_radial_glow(img):
    glow = Image.new("L", (W, H), 0)
    gdraw = ImageDraw.Draw(glow)
    cx, cy = W // 2, int(H * 0.34)
    max_r = int(W * 0.62)
    for r in range(max_r, 0, -6):
        alpha = int(90 * (1 - r / max_r) ** 1.6)
        gdraw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=alpha)
    glow = glow.filter(ImageFilter.GaussianBlur(40))
    tint = Image.new("RGB", (W, H), ACCENT)
    img.paste(tint, (0, 0), glow)
    return img


def add_texture_rings(img):
    draw = ImageDraw.Draw(img, "RGBA")
    cx, cy = W // 2, int(H * 0.34)
    for i, r in enumerate([420, 480, 540]):
        alpha = 26 - i * 6
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(GOLD[0], GOLD[1], GOLD[2], alpha), width=2)
    return img


def load_font(size, bold=False):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_emblem(img):
    draw = ImageDraw.Draw(img, "RGBA")
    cx, cy = W // 2, int(H * 0.34)
    r_outer = 210

    # Outer ring
    draw.ellipse([cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer],
                 outline=GOLD, width=6)
    draw.ellipse([cx - r_outer + 16, cy - r_outer + 16, cx + r_outer - 16, cy + r_outer - 16],
                 outline=(GOLD[0], GOLD[1], GOLD[2], 140), width=2)

    # Inner filled disc
    r_inner = r_outer - 30
    draw.ellipse([cx - r_inner, cy - r_inner, cx + r_inner, cy + r_inner],
                 fill=(255, 255, 255, 18))

    # A simple ring of "voices" dots (representing a choir standing in an
    # arc) around a central music note — enough to read as an emblem
    # without pretending to be a real coat of arms.
    n_dots = 9
    dot_r = 9
    ring_r = r_inner - 34
    for i in range(n_dots):
        angle = math.pi * (0.15 + 0.7 * i / (n_dots - 1))
        dx = cx + ring_r * math.cos(angle)
        dy = cy + ring_r * math.sin(angle) * -1 + 40
        draw.ellipse([dx - dot_r, dy - dot_r, dx + dot_r, dy + dot_r], fill=GOLD)

    # Music note (two stacked, joined by a beam) centered a bit lower
    note_x, note_y = cx, cy + 20
    head_r = 22
    stem_h = 130
    # left note head + stem
    draw.ellipse([note_x - 70 - head_r, note_y + stem_h - head_r * 0.7,
                  note_x - 70 + head_r, note_y + stem_h + head_r * 0.7], fill=INK)
    draw.line([note_x - 70 + head_r - 4, note_y + stem_h, note_x - 70 + head_r - 4, note_y - 10],
               fill=INK, width=8)
    # right note head + stem
    draw.ellipse([note_x + 30 - head_r, note_y + stem_h - head_r * 0.7,
                  note_x + 30 + head_r, note_y + stem_h + head_r * 0.7], fill=INK)
    draw.line([note_x + 30 + head_r - 4, note_y + stem_h, note_x + 30 + head_r - 4, note_y - 40],
               fill=INK, width=8)
    # beam connecting the two stems
    draw.line([note_x - 70 + head_r - 4, note_y - 10, note_x + 30 + head_r - 4, note_y - 40],
               fill=INK, width=10)

    return img


def draw_text(img):
    draw = ImageDraw.Draw(img, "RGBA")
    cx = W // 2

    title_font = load_font(96, bold=True)
    subtitle_font = load_font(40)
    small_font = load_font(30)

    title = "CORO RODAL"
    title_y = int(H * 0.34) + 260

    bbox = draw.textbbox((0, 0), title, font=title_font)
    tw = bbox[2] - bbox[0]
    draw.text((cx - tw / 2, title_y), title, font=title_font, fill=INK)

    subtitle = "Agrupación Coral"
    bbox = draw.textbbox((0, 0), subtitle, font=subtitle_font)
    sw = bbox[2] - bbox[0]
    draw.text((cx - sw / 2, title_y + 118), subtitle, font=subtitle_font, fill=(GOLD[0], GOLD[1], GOLD[2], 255))

    # small line separator
    line_y = title_y + 190
    draw.line([cx - 70, line_y, cx + 70, line_y], fill=(GOLD[0], GOLD[1], GOLD[2], 180), width=2)

    footer = "imagen de prueba — Pase Único"
    bbox = draw.textbbox((0, 0), footer, font=small_font)
    fw = bbox[2] - bbox[0]
    draw.text((cx - fw / 2, H - 90), footer, font=small_font, fill=(INK[0], INK[1], INK[2], 130))

    return img


def add_vignette(img):
    # Radial darkening toward the corners, built from a single filled
    # ellipse (not nested outlines) so it blurs into a smooth gradient
    # instead of banding.
    vignette = Image.new("L", (W, H), 255)
    vdraw = ImageDraw.Draw(vignette)
    cx, cy = W // 2, int(H * 0.42)
    rx, ry = int(W * 0.62), int(H * 0.5)
    vdraw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=0)
    vignette = vignette.filter(ImageFilter.GaussianBlur(180))
    black = Image.new("RGB", (W, H), (0, 0, 0))
    img.paste(black, (0, 0), vignette)
    return img


def main():
    img = build_background()
    img = add_radial_glow(img)
    img = add_texture_rings(img)
    img = draw_emblem(img)
    img = draw_text(img)
    img = add_vignette(img)
    img = img.convert("RGB")
    img.save(OUT_PATH, "JPEG", quality=90)
    print("wrote", OUT_PATH, img.size)


if __name__ == "__main__":
    main()
