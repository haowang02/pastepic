"""Builds src/fonts/pastepic-display.woff2, the heading font, from 得意黑 Smiley Sans.

Keeps ASCII plus every CJK character used in the UI source, so re-run it after changing copy:

    pip install fonttools brotli
    python3 scripts/subset-font.py path/to/SmileySans-Oblique.ttf

Smiley Sans is licensed under the SIL OFL 1.1 with the Reserved Font Names "Smiley" and "得意黑".
A subset is a Modified Version under the OFL, so it must not carry those names: the family is
renamed to "Pastepic Display" while the copyright and license records are kept.
"""

import re
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "src" / "fonts" / "pastepic-display.woff2"
FAMILY = "Pastepic Display"
KEEP_NAME_IDS = {0, 13, 14}  # copyright, license description, license URL


def ui_characters() -> str:
    sources = [ROOT / "index.html", *sorted((ROOT / "src").glob("*.ts"))]
    text = "".join(p.read_text(encoding="utf-8") for p in sources)
    return "".join(sorted(set(re.findall(r"[　-〿㐀-鿿＀-￯]", text))))


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    chars = ui_characters()
    font = TTFont(sys.argv[1])

    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=chars, unicodes=list(range(0x20, 0x7F)) + [0xD7, 0x2026])
    subsetter.subset(font)

    names = font["name"]
    names.names = [n for n in names.names if n.nameID in KEEP_NAME_IDS]
    for name_id, value in {1: FAMILY, 2: "Regular", 3: f"{FAMILY} subset", 4: FAMILY, 6: "PastepicDisplay-Regular"}.items():
        names.setName(value, name_id, 3, 1, 0x409)
    font.flavor = "woff2"
    font.save(OUTPUT)
    print(f"{len(chars)} CJK glyphs -> {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
