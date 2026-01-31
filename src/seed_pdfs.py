from pathlib import Path

import pdf_ingest
import weaviate_utils


DEFAULT_PDFS_DIR = Path(__file__).resolve().parent.parent / "data" / "VSCHT" / "pdfs"
SEED_COLLECTION = weaviate_utils.seed_collection_name()


def main() -> None:
    if not DEFAULT_PDFS_DIR.exists():
        raise SystemExit(f"PDF directory not found: {DEFAULT_PDFS_DIR}")
    pdf_paths = sorted(DEFAULT_PDFS_DIR.glob("*.pdf"))
    if not pdf_paths:
        raise SystemExit(f"No PDFs found in: {DEFAULT_PDFS_DIR}")
    total_chunks = 0
    for pdf_path in pdf_paths:
        result = pdf_ingest.ingest_pdf_file(pdf_path, collection_name=SEED_COLLECTION)
        total_chunks += int(result.get("chunks", 0))
    print(f"Seeded {len(pdf_paths)} PDFs into {SEED_COLLECTION} ({total_chunks} chunks).")


if __name__ == "__main__":
    main()
