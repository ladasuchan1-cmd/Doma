#!/usr/bin/env python3
"""Sestaví webovou verzi Boubínského kvízu (stránka na claude.ai) do zadané složky.

    python3 kviz/webapp/build.py VÝSTUP [ukazky.json]

ukazky.json = {"titanic": "<adresa nahrané ukázky>", ...}; klíč je normalizovaný název souboru
(stejně jako Names.norm v aplikaci). Kvízy se berou beze změny z kviz/web, přidá se jen mobilní
vrstva z Android aplikace (mobile.css, bridge.js). Na konec vypíše mapu `files` pro publikování:
pozadí jsou JPEG, ale kvíz je volá jako .png, proto mají vlastní contentType.
"""
import json
import re
import shutil
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
APP = ROOT / "android/app/src/main/assets/app"


def norm(s):
    s = "".join(c for c in unicodedata.normalize("NFD", s) if not 0x300 <= ord(c) <= 0x36F).lower()
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\.[a-z0-9]+$", "", s))


def main(out, media):
    out.mkdir(parents=True, exist_ok=True)
    (out / "pozadi").mkdir(exist_ok=True)
    files, kvizy = {}, []
    for page in sorted(WEB.glob("kviz-*.html")):
        html = page.read_text(encoding="utf-8")
        blocks = json.loads(re.search(r"const BLOCKS = (\[.*?\]);\nconst SECONDS", html, re.S).group(1))
        title = re.search(r"<title>(.*?)</title>", html).group(1)
        keys = [norm(it["f"][0]) for b in blocks for r in b for it in r["items"] if it["t"] == "m"]
        kvizy.append({"file": page.name, "title": title, "no": re.search(r"(\d+)\s*$", title).group(1),
                      "rounds": [r["name"] for b in blocks for r in b],
                      "have": sum(k in media for k in keys), "total": len(keys)})
        html = html.replace("</head>", '<link rel="stylesheet" href="mobile.css">\n</head>', 1)
        i = html.rindex("</body>")
        html = html[:i] + '<script src="ukazky.js"></script>\n<script src="bridge.js"></script>\n' + html[i:]
        (out / page.name).write_text(html, encoding="utf-8")
        files[page.name] = page.name

    menu = (Path(__file__).parent / "index.html").read_text(encoding="utf-8")
    (out / "index.html").write_text(menu.replace("/*KVIZY*/[]", json.dumps(kvizy, ensure_ascii=False)), encoding="utf-8")
    for f in ("mobile.css", "bridge.js"):
        shutil.copy(APP / f, out / f)
        files[f] = f
    (out / "ukazky.js").write_text("window.KVIZ_MEDIA = " + json.dumps(media, ensure_ascii=False, indent=0) + ";\n", encoding="utf-8")
    files["ukazky.js"] = "ukazky.js"
    for jpg in sorted((WEB / "pozadi").glob("*.jpg")):
        name = "pozadi/" + jpg.stem + ".png"
        shutil.copy(jpg, out / name)
        files[name] = {"from": name, "contentType": "image/jpeg"}
    print(json.dumps(files, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    media = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")) if len(sys.argv) > 2 else {}
    main(Path(sys.argv[1]), media)
