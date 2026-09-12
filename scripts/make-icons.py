#!/usr/bin/env python3
"""Genere les icones PWA sans dependance externe.

Ecrit directement le format PNG (signature + IHDR + IDAT + IEND) pour eviter
d'ajouter Pillow ou ImageMagick a la chaine de build : les icones changent une
fois par an, une dependance de plus ne se justifie pas.

Le rendu se fait a 4x puis est reduit par moyenne de blocs, ce qui donne un
anti-crenelage correct sur les coins arrondis sans code de rasterisation.
"""
from __future__ import annotations

import pathlib
import struct
import zlib

SUPERSAMPLE = 4

BLUE = (26, 115, 232)
# Bandeau superieur : un blanc se confondrait avec le fond de l'icone.
BLUE_DARK = (19, 79, 161)
WHITE = (255, 255, 255)
RED = (217, 48, 37)

Pixel = tuple[int, int, int]


def write_png(path: pathlib.Path, pixels: list[list[Pixel]]) -> None:
    """Encode une matrice RGB en PNG 8 bits sans canal alpha."""
    height = len(pixels)
    width = len(pixels[0])

    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filtre 0 (None) : suffisant pour des aplats
        for red, green, blue in row:
            raw += bytes((red, green, blue))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack('>I', len(payload)) + body + struct.pack('>I', zlib.crc32(body))

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')

    path.write_bytes(png)


def rounded_rect(x: float, y: float, w: float, h: float, radius: float):
    """Predicat d'appartenance a un rectangle a coins arrondis.

    On projette le point sur le rectangle interieur (celui des centres de
    coins) puis on compare la distance au rayon. Cette seule verification
    couvre a la fois les bords droits (distance nulle) et les quatre angles,
    sans cas particulier. Le rayon est borne a la demi-hauteur/demi-largeur
    pour que la projection reste valide sur un bandeau plus bas que 2r.
    """
    radius = max(0.0, min(radius, w / 2, h / 2))

    def inside(px: float, py: float) -> bool:
        cx = min(max(px, x + radius), x + w - radius)
        cy = min(max(py, y + radius), y + h - radius)
        return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2

    return inside


def render(size: int, padding_ratio: float, bleed: bool = False) -> list[list[Pixel]]:
    """Dessine l'icone : carre bleu arrondi, bandeau blanc, grille de points."""
    hi = size * SUPERSAMPLE
    pad = hi * padding_ratio

    card = rounded_rect(pad, pad, hi - 2 * pad, hi - 2 * pad, hi * 0.16)
    card_x, card_y = pad, pad
    card_w, card_h = hi - 2 * pad, hi - 2 * pad

    header_h = card_h * 0.26

    def header(px: float, py: float) -> bool:
        return card_y <= py < card_y + header_h

    # Deux anneaux de reliure debordant du bandeau.
    ring_r = card_w * 0.045
    rings = [
        (card_x + card_w * 0.30, card_y + header_h * 0.42),
        (card_x + card_w * 0.70, card_y + header_h * 0.42),
    ]

    # Grille 4 x 3 de pastilles, comme les evenements d'un mois.
    dots: list[tuple[float, float, float, Pixel]] = []
    cols, rows = 4, 3
    grid_top = card_y + header_h + card_h * 0.10
    grid_h = card_h - header_h - card_h * 0.20
    cell_w = card_w / (cols + 1)
    cell_h = grid_h / rows
    dot_r = min(cell_w, cell_h) * 0.30

    for row in range(rows):
        for col in range(cols):
            cx = card_x + cell_w * (col + 1)
            cy = grid_top + cell_h * (row + 0.5)
            # Une pastille rouge pour evoquer "aujourd'hui".
            color = RED if (row, col) == (1, 2) else WHITE
            dots.append((cx, cy, dot_r, color))

    supersampled: list[list[Pixel]] = []
    for py in range(hi):
        row_pixels: list[Pixel] = []
        yc = py + 0.5
        for px in range(hi):
            xc = px + 0.5
            color: Pixel = BLUE if bleed else WHITE

            if card(xc, yc):
                color = BLUE
                if header(xc, yc):
                    color = BLUE_DARK
                for rx, ry in rings:
                    if (xc - rx) ** 2 + (yc - ry) ** 2 <= ring_r ** 2:
                        color = WHITE
                for dx, dy, dr, dot_color in dots:
                    if (xc - dx) ** 2 + (yc - dy) ** 2 <= dr ** 2:
                        color = dot_color

            row_pixels.append(color)
        supersampled.append(row_pixels)

    # Reduction par moyenne de blocs SUPERSAMPLE x SUPERSAMPLE.
    output: list[list[Pixel]] = []
    area = SUPERSAMPLE * SUPERSAMPLE
    for y in range(size):
        row_out: list[Pixel] = []
        for x in range(size):
            totals = [0, 0, 0]
            for sy in range(SUPERSAMPLE):
                source_row = supersampled[y * SUPERSAMPLE + sy]
                for sx in range(SUPERSAMPLE):
                    pixel = source_row[x * SUPERSAMPLE + sx]
                    totals[0] += pixel[0]
                    totals[1] += pixel[1]
                    totals[2] += pixel[2]
            row_out.append((totals[0] // area, totals[1] // area, totals[2] // area))
        output.append(row_out)

    return output


FAVICON_SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#1a73e8"/>
  <path d="M0 14a14 14 0 0 1 14-14h36a14 14 0 0 1 14 14v4H0z" fill="#134fa1"/>
  <circle cx="22" cy="9" r="3" fill="#fff"/>
  <circle cx="42" cy="9" r="3" fill="#fff"/>
  <g fill="#fff">
    <circle cx="18" cy="32" r="4"/><circle cx="32" cy="32" r="4"/><circle cx="46" cy="32" r="4"/>
    <circle cx="18" cy="46" r="4"/><circle cx="46" cy="46" r="4"/>
  </g>
  <circle cx="32" cy="46" r="4" fill="#d93025"/>
</svg>
'''


def main() -> None:
    public = pathlib.Path(__file__).resolve().parent.parent / 'public'
    public.mkdir(exist_ok=True)

    targets = [
        ('icon-192.png', 192, 0.04, False),
        ('icon-512.png', 512, 0.04, False),
        # Icone maskable : iOS et Android rognent jusqu'a 20 % sur les bords,
        # d'ou la marge interne beaucoup plus large.
        ('icon-512-maskable.png', 512, 0.16, True),
        ('apple-touch-icon.png', 180, 0.06, True),
    ]

    for filename, size, padding, bleed in targets:
        write_png(public / filename, render(size, padding, bleed))
        print(f'  {filename} ({size}x{size})')

    (public / 'favicon.svg').write_text(FAVICON_SVG, encoding='utf-8')
    print('  favicon.svg')


if __name__ == '__main__':
    main()
