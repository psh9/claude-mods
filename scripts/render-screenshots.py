#!/usr/bin/env python3
"""Turn the file-tree mod's drawings into terminal-style SVG screenshots.

The scene tests (mods/file-tree/tests/screenshots.test.tsx) print each drawing
the mod returned as one `SCENE <name> <json>` line. This lays those element
trees out on a character grid the way the terminal does (columns, rows,
widths, space-between, backgrounds) and writes docs/<name>.svg.

    claude plugin test mods/file-tree | python3 scripts/render-screenshots.py
"""
import json
import os
import sys
from html import escape

BG = "#1a1b26"
CHROME = "#16161e"
BORDER = "#3b4261"
FG = "#c0caf5"
DIM = "#565f89"
CELL_W = 8.4
CELL_H = 20
FONT = 14
PAD = 18
TITLE_H = 34

TITLES = {
    "pane": "Files",
    "follow": "Files",
    "band": "above the prompt",
}


class Cell:
    __slots__ = ("ch", "fg", "bg", "bold", "italic", "strike")

    def __init__(self, ch, style):
        self.ch = ch
        self.fg = style.get("fg")
        self.bg = style.get("bg")
        self.bold = style.get("bold", False)
        self.italic = style.get("italic", False)
        self.strike = style.get("strike", False)


def text_cells(el, style):
    props = el.get("props", {})
    style = dict(style)
    if props.get("color"):
        style["fg"] = props["color"]
    if props.get("backgroundColor"):
        style["bg"] = props["backgroundColor"]
    if props.get("dimColor"):
        style["fg"] = DIM
    for key, prop in (("bold", "bold"), ("italic", "italic"), ("strike", "strikethrough")):
        if props.get(prop):
            style[key] = True
    cells = []
    for child in el.get("children", []):
        if isinstance(child, str):
            cells.extend(Cell(ch, style) for ch in child)
        elif isinstance(child, dict):
            cells.extend(text_cells(child, style))
    return cells


def pad(line, width, bg=None):
    line = line[:width]
    return line + [Cell(" ", {"bg": bg}) for _ in range(width - len(line))]


def layout(el, width):
    """Lines of cells for one element, at most `width` wide."""
    if not isinstance(el, dict):
        return []
    if el.get("type") == "Text":
        return [text_cells(el, {})[:width]]

    props = el.get("props", {})
    if isinstance(props.get("width"), (int, float)):
        width = min(width, int(props["width"]))
    left = int(props.get("paddingLeft", 0) or 0)
    inner = max(0, width - left)
    children = [child for child in el.get("children", []) if isinstance(child, dict)]
    gap = int(props.get("columnGap", props.get("gap", 0)) or 0)

    if props.get("flexDirection") == "row":
        blocks = []
        for child in children:
            lines = layout(child, inner)
            own = child.get("props", {}).get("width")
            natural = int(own) if isinstance(own, (int, float)) else max((len(l) for l in lines), default=0)
            blocks.append((lines, natural))
        used = sum(w for _, w in blocks) + gap * max(0, len(blocks) - 1)
        if used > inner and blocks:
            # Too wide: the first child gives way, as its flexShrink does.
            first_lines, first_w = blocks[0]
            blocks[0] = (first_lines, max(0, first_w - (used - inner)))
            used = inner
        spare = inner - used
        gaps = [gap] * max(0, len(blocks) - 1)
        if props.get("justifyContent") == "space-between" and len(blocks) > 1:
            each, rest = divmod(spare, len(blocks) - 1)
            gaps = [gap + each] * (len(blocks) - 1)
            gaps[-1] += rest
        height = max((len(lines) for lines, _ in blocks), default=0)
        out = []
        for row in range(height):
            line = []
            for index, (lines, w) in enumerate(blocks):
                line += pad(lines[row] if row < len(lines) else [], w)
                if index < len(gaps):
                    line += pad([], gaps[index])
            out.append(line)
    else:
        out = []
        for child in children:
            out += layout(child, inner)

    if left:
        out = [pad([], left) + line for line in out]
    bg = props.get("backgroundColor")
    if bg:
        filled = []
        for line in out:
            line = pad(line, width)
            for cell in line:
                cell.bg = cell.bg or bg
            filled.append(line)
        out = filled
    return [line[:width] for line in out]


def svg(name, lines, width):
    cols = width
    body_w = cols * CELL_W
    w = body_w + PAD * 2
    h = TITLE_H + len(lines) * CELL_H + PAD * 2
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h:.0f}" viewBox="0 0 {w:.0f} {h:.0f}">',
        f'<rect width="100%" height="100%" rx="10" fill="{BG}" stroke="{BORDER}"/>',
        f'<path d="M0 10 a10 10 0 0 1 10 -10 h{w - 20:.0f} a10 10 0 0 1 10 10 v{TITLE_H - 10} h-{w:.0f} z" fill="{CHROME}"/>',
        f'<circle cx="18" cy="17" r="6" fill="#f7768e"/><circle cx="38" cy="17" r="6" fill="#e0af68"/><circle cx="58" cy="17" r="6" fill="#9ece6a"/>',
        f'<text x="{w / 2:.0f}" y="22" fill="{DIM}" font-family="SF Mono, Menlo, Consolas, monospace" font-size="12" text-anchor="middle">file-tree: {escape(TITLES.get(name, name))}</text>',
        f'<g font-family="SF Mono, Menlo, Consolas, DejaVu Sans Mono, monospace" font-size="{FONT}" xml:space="preserve">',
    ]
    for row, line in enumerate(lines):
        y = TITLE_H + PAD + row * CELL_H
        # Backgrounds first, one rect per run of the same color.
        col = 0
        while col < len(line):
            bg = line[col].bg
            end = col
            while end < len(line) and line[end].bg == bg:
                end += 1
            if bg:
                parts.append(f'<rect x="{PAD + col * CELL_W:.1f}" y="{y:.1f}" width="{(end - col) * CELL_W:.1f}" height="{CELL_H}" fill="{bg}"/>')
            col = end
        # Text, one element per style run, every glyph placed on its own grid
        # column so no font can stretch, squeeze or drop a space.
        col = 0
        while col < len(line):
            cell = line[col]
            key = (cell.fg, cell.bold, cell.italic, cell.strike)
            end = col
            while end < len(line) and (line[end].fg, line[end].bold, line[end].italic, line[end].strike) == key:
                end += 1
            glyphs = [(index, line[index].ch) for index in range(col, end) if line[index].ch != " "]
            if glyphs:
                attrs = [f'fill="{cell.fg or FG}"']
                if cell.bold:
                    attrs.append('font-weight="bold"')
                if cell.italic:
                    attrs.append('font-style="italic"')
                xs = " ".join(f"{PAD + index * CELL_W:.1f}" for index, _ in glyphs)
                text = escape("".join(ch for _, ch in glyphs))
                parts.append(f'<text x="{xs}" y="{y + CELL_H * 0.72:.1f}" {" ".join(attrs)}>{text}</text>')
            if cell.strike and glyphs:
                strike_y = y + CELL_H * 0.5
                parts.append(
                    f'<line x1="{PAD + col * CELL_W:.1f}" y1="{strike_y:.1f}" x2="{PAD + end * CELL_W:.1f}" '
                    f'y2="{strike_y:.1f}" stroke="{cell.fg or FG}" stroke-width="1"/>'
                )
            col = end
    parts += ["</g>", "</svg>"]
    return "\n".join(parts) + "\n"


CHROMES = [
    os.environ.get("CHROME", ""),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]


def png(svg_path, width, height):
    """A 2x PNG beside the SVG, drawn by headless Chrome where there is one."""
    import subprocess

    chrome = next((path for path in CHROMES if path and os.path.exists(path)), None)
    if chrome is None:
        return None
    out = svg_path[: -len(".svg")] + ".png"
    subprocess.run(
        [
            chrome, "--headless", "--disable-gpu", "--hide-scrollbars",
            "--force-device-scale-factor=2", f"--window-size={width},{height}",
            "--default-background-color=00000000", f"--screenshot={out}",
            f"file://{os.path.abspath(svg_path)}",
        ],
        check=True, capture_output=True, timeout=60,
    )
    return out


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs")
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for raw in sys.stdin:
        if not raw.startswith("SCENE "):
            continue
        _, name, payload = raw.rstrip("\n").split(" ", 2)
        tree = json.loads(payload)
        width = int(tree.get("props", {}).get("width", 60))
        lines = layout(tree, width)
        path = os.path.join(out_dir, f"{name}.svg")
        with open(path, "w", encoding="utf-8") as f:
            f.write(svg(name, lines, width))
        written.append(path)
        size_w = round(width * CELL_W + PAD * 2)
        size_h = round(TITLE_H + len(lines) * CELL_H + PAD * 2)
        made = png(path, size_w, size_h)
        print(f"{name}: {len(lines)} rows{', png too' if made else ''}")
        for line in lines:
            print("  " + "".join(c.ch for c in line).rstrip())
    if not written:
        sys.exit("no SCENE lines on stdin")


if __name__ == "__main__":
    main()
