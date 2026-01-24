from __future__ import annotations

from pathlib import Path
from typing import Iterable

import pymupdf
from langchain_text_splitters import RecursiveCharacterTextSplitter

import weaviate_utils


CHUNK_SIZE = 3600
CHUNK_OVERLAP = 600


def _normalize_text(text: str) -> str:
    lines = [line.rstrip() for line in text.splitlines()]
    cleaned: list[str] = []
    blank = 0
    for line in lines:
        if not line.strip():
            blank += 1
            if blank > 1:
                continue
            cleaned.append("")
        else:
            blank = 0
            cleaned.append(line)
    return "\n".join(cleaned).strip()


def extract_pages_text(pdf_path: Path) -> list[tuple[int, str]]:
    pages: list[tuple[int, str]] = []
    with pymupdf.open(pdf_path) as doc:
        for page_index, page in enumerate(doc, start=1):
            text = page.get_text("text", sort=True)
            text = _normalize_text(text)
            if text:
                pages.append((page_index, text))
    return pages


def build_chunks(
    pdf_path: Path,
    pages: Iterable[tuple[int, str]],
    splitter: RecursiveCharacterTextSplitter,
) -> list[dict]:
    items: list[dict] = []
    for page_index, text in pages:
        if not text:
            continue
        page_markdown = f"## Page {page_index}\n\n{text}"
        for chunk_index, chunk in enumerate(splitter.split_text(page_markdown), start=1):
            chunk = chunk.strip()
            if not chunk:
                continue
            content = f"# {pdf_path.stem}\n\n{chunk}".strip()
            items.append(
                {
                    "title": f"{pdf_path.stem} p{page_index} c{chunk_index}",
                    "content": content,
                    "source": f"{pdf_path}#page={page_index}",
                }
            )
    return items


def ingest_pdf_file(pdf_path: Path, collection_name: str) -> dict:
    pages = extract_pages_text(pdf_path)
    if not pages:
        return {"chunks": 0, "pages": 0, "source_base": str(pdf_path)}

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
    )
    items = build_chunks(pdf_path, pages, splitter)
    if not items:
        return {"chunks": 0, "pages": len(pages), "source_base": str(pdf_path)}

    uploaded = weaviate_utils.upload_texts(items, collection_name=collection_name)
    return {"chunks": uploaded, "pages": len(pages), "source_base": str(pdf_path)}
