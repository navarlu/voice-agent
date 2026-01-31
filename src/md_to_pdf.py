from __future__ import annotations

from pathlib import Path

import markdown
from weasyprint import HTML

INPUT_DIR = Path("data/VSCHT")
OUTPUT_DIR = INPUT_DIR / "pdfs"

CSS = """
@page { size: A4; margin: 2cm; }
body { font-family: "DejaVu Serif", serif; font-size: 11pt; line-height: 1.45; color: #111; }
h1, h2, h3, h4 { color: #0b2f5b; margin-bottom: 0.4em; }
h1 { font-size: 22pt; border-bottom: 1px solid #c7d2e3; padding-bottom: 0.2em; }
code, pre { font-family: "DejaVu Sans Mono", monospace; font-size: 9.5pt; }
pre { background: #f5f7fa; padding: 0.6em 0.8em; border: 1px solid #e1e6ef; }
table { border-collapse: collapse; width: 100%; margin: 0.6em 0; }
th, td { border: 1px solid #cfd7e6; padding: 0.35em 0.45em; }
th { background: #eef2f8; }
"""


def render_markdown_to_pdf(md_path: Path, pdf_path: Path) -> None:
    md_text = md_path.read_text(encoding="utf-8")
    body_html = markdown.markdown(
        md_text,
        extensions=["extra", "tables", "fenced_code", "toc"],
    )
    html = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>{md_path.stem}</title>
    <style>{CSS}</style>
  </head>
  <body>
    {body_html}
  </body>
</html>
"""
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    HTML(string=html, base_url=str(md_path.parent.resolve())).write_pdf(
        str(pdf_path)
    )


def main() -> None:
    if not INPUT_DIR.exists():
        raise SystemExit(f"Input directory not found: {INPUT_DIR}")

    md_files = sorted(INPUT_DIR.glob("*.md"))
    if not md_files:
        raise SystemExit(f"No markdown files found in {INPUT_DIR}")

    for md_path in md_files:
        pdf_path = OUTPUT_DIR / f"{md_path.stem}.pdf"
        render_markdown_to_pdf(md_path, pdf_path)
        print(f"Wrote {pdf_path}")


if __name__ == "__main__":
    main()
