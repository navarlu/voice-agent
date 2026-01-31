from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Iterable

import weaviate
from datetime import datetime, timezone
from weaviate.classes.config import Configure, DataType, Property
from weaviate.classes.query import MetadataQuery
from weaviate.collections.classes import grpc


WEAVIATE_HOST = os.getenv("WEAVIATE_HOST", "localhost")
WEAVIATE_HTTP_PORT = int(os.getenv("WEAVIATE_HTTP_PORT", "8080"))
WEAVIATE_GRPC_PORT = int(os.getenv("WEAVIATE_GRPC_PORT", "50051"))
WEAVIATE_COLLECTION = os.getenv("WEAVIATE_COLLECTION", "vector_database_v001")
WEAVIATE_SEED_COLLECTION = os.getenv("WEAVIATE_SEED_COLLECTION", "seed_vscht")
WEAVIATE_OPENAI_MODEL = os.getenv("WEAVIATE_OPENAI_MODEL", "text-embedding-3-large")
WEAVIATE_SEARCH_MODE = os.getenv("WEAVIATE_SEARCH_MODE", "hybrid") #semantic
WEAVIATE_HYBRID_ALPHA = float(os.getenv("WEAVIATE_HYBRID_ALPHA", "0.7"))

DOC_TITLE_FIELD = "title"
DOC_CONTENT_FIELD = "content"
DOC_SOURCE_FIELD = "source"
DOC_CREATED_AT_FIELD = "created_at"

def normalize_collection_name(user_name: str) -> str:
    base = (user_name or "").strip().lower()
    safe = "".join(ch if ch.isalnum() else "_" for ch in base)
    safe = "_".join(part for part in safe.split("_") if part)
    if not safe:
        safe = "guest"
    return f"user_{safe}"


def seed_collection_name() -> str:
    value = (WEAVIATE_SEED_COLLECTION or "").strip()
    return value or "seed_vscht"


def connect_client():
    return weaviate.connect_to_local(
        host=WEAVIATE_HOST,
        port=WEAVIATE_HTTP_PORT,
        grpc_port=WEAVIATE_GRPC_PORT,
    )


def list_collections() -> list[str]:
    with connect_client() as client:
        configs = client.collections.list_all(simple=True)
    return sorted(configs.keys())


def wait_for_weaviate(
    max_wait_s: int = 20,
    interval_s: float = 1.5,
    debug: bool = False,
) -> bool:
    deadline = time.monotonic() + max_wait_s
    while time.monotonic() < deadline:
        try:
            with connect_client() as client:
                if client.is_ready():
                    if debug:
                        print("Weaviate ready.")
                    return True
        except Exception:
            if debug:
                print("Weaviate check failed; retrying...")
        time.sleep(interval_s)
    return False


def ensure_collection(client, name: str = WEAVIATE_COLLECTION) -> None:
    if client.collections.exists(name):
        collection = client.collections.use(name)
        config = collection.config.get(simple=True)
        existing = {prop.name for prop in config.properties}
        missing = []
        if DOC_TITLE_FIELD not in existing:
            missing.append(Property(name=DOC_TITLE_FIELD, data_type=DataType.TEXT))
        if DOC_CONTENT_FIELD not in existing:
            missing.append(Property(name=DOC_CONTENT_FIELD, data_type=DataType.TEXT))
        if DOC_SOURCE_FIELD not in existing:
            missing.append(Property(name=DOC_SOURCE_FIELD, data_type=DataType.TEXT))
        if DOC_CREATED_AT_FIELD not in existing:
            missing.append(Property(name=DOC_CREATED_AT_FIELD, data_type=DataType.DATE))
        for prop in missing:
            collection.config.add_property(prop)
        return
    client.collections.create(
        name=name,
        properties=[
            Property(name=DOC_TITLE_FIELD, data_type=DataType.TEXT),
            Property(name=DOC_CONTENT_FIELD, data_type=DataType.TEXT),
            Property(name=DOC_SOURCE_FIELD, data_type=DataType.TEXT),
            Property(name=DOC_CREATED_AT_FIELD, data_type=DataType.DATE),
        ],
        vector_config=Configure.Vectors.text2vec_openai(
            model=WEAVIATE_OPENAI_MODEL,
            source_properties=[DOC_TITLE_FIELD, DOC_CONTENT_FIELD],
            vectorize_collection_name=False,
        ),
    )


def _iter_txt_files(paths: Iterable[str | Path]) -> Iterable[Path]:
    for path in paths:
        path = Path(path)
        if path.is_dir():
            for file_path in sorted(path.rglob("*.txt")):
                yield file_path
        elif path.suffix.lower() == ".txt":
            yield path


def _insert_documents(client, items: Iterable[dict], collection_name: str) -> int:
    ensure_collection(client, collection_name)
    collection = client.collections.use(collection_name)
    count = 0
    for item in items:
        title = item.get("title", "Untitled")
        content = item.get("content", "")
        source = item.get("source", "")
        if not content:
            continue
        created_at = item.get("created_at") or datetime.now(timezone.utc).isoformat()
        collection.data.insert(
            {
                DOC_TITLE_FIELD: title,
                DOC_CONTENT_FIELD: content,
                DOC_SOURCE_FIELD: source,
                DOC_CREATED_AT_FIELD: created_at,
            }
        )
        count += 1
    return count


def insert_document(
    title: str,
    content: str,
    source: str,
    collection_name: str = WEAVIATE_COLLECTION,
) -> str:
    with connect_client() as client:
        created_at = datetime.now(timezone.utc).isoformat()
        ensure_collection(client, collection_name)
        collection = client.collections.use(collection_name)
        return str(
            collection.data.insert(
                {
                    DOC_TITLE_FIELD: title,
                    DOC_CONTENT_FIELD: content,
                    DOC_SOURCE_FIELD: source,
                    DOC_CREATED_AT_FIELD: created_at,
                }
            )
        )


def upload_txt_files(paths: Iterable[str | Path], collection_name: str = WEAVIATE_COLLECTION) -> int:
    file_paths = list(_iter_txt_files(paths))
    if not file_paths:
        return 0
    items = []
    for file_path in file_paths:
        text = file_path.read_text(encoding="utf-8", errors="ignore").strip()
        if not text:
            continue
        items.append(
            {
                "title": file_path.stem,
                "content": text,
                "source": str(file_path),
            }
        )
    with connect_client() as client:
        return _insert_documents(client, items, collection_name)


def upload_texts(
    items: Iterable[dict],
    collection_name: str = WEAVIATE_COLLECTION,
) -> int:
    with connect_client() as client:
        return _insert_documents(client, items, collection_name)


def _format_results(response) -> list[dict]:
    results = []
    for obj in response.objects:
        props = obj.properties or {}
        created_at = props.get(DOC_CREATED_AT_FIELD, "")
        if isinstance(created_at, datetime):
            created_at = created_at.isoformat()
        results.append(
            {
                "id": str(getattr(obj, "uuid", "")),
                "title": props.get(DOC_TITLE_FIELD, ""),
                "content": props.get(DOC_CONTENT_FIELD, ""),
                "source": props.get(DOC_SOURCE_FIELD, ""),
                "created_at": created_at,
                "distance": getattr(obj.metadata, "distance", None),
                "score": getattr(obj.metadata, "score", None),
            }
        )
    return results


def search_semantic(query: str, limit: int = 5, collection_name: str = WEAVIATE_COLLECTION) -> list[dict]:
    with connect_client() as client:
        ensure_collection(client, collection_name)
        collection = client.collections.use(collection_name)
        response = collection.query.near_text(
            query=query,
            limit=limit,
            return_metadata=MetadataQuery(distance=True),
            return_properties=[
                DOC_TITLE_FIELD,
                DOC_CONTENT_FIELD,
                DOC_SOURCE_FIELD,
                DOC_CREATED_AT_FIELD,
            ],
        )
        return _format_results(response)


def search_keyword(
    query: str,
    fields: Iterable[str] | None = None,
    limit: int = 10,
    collection_name: str = WEAVIATE_COLLECTION,
) -> list[dict]:
    query_fields = list(fields or [DOC_TITLE_FIELD, DOC_CONTENT_FIELD])
    with connect_client() as client:
        ensure_collection(client, collection_name)
        collection = client.collections.use(collection_name)
        response = collection.query.bm25(
            query=query,
            query_properties=query_fields,
            limit=limit,
            return_metadata=MetadataQuery(score=True),
            return_properties=[
                DOC_TITLE_FIELD,
                DOC_CONTENT_FIELD,
                DOC_SOURCE_FIELD,
                DOC_CREATED_AT_FIELD,
            ],
        )
        return _format_results(response)


def search_hybrid(
    query: str,
    fields: Iterable[str] | None = None,
    limit: int = 10,
    alpha: float = WEAVIATE_HYBRID_ALPHA,
    collection_name: str = WEAVIATE_COLLECTION,
) -> list[dict]:
    query_fields = list(fields or [DOC_TITLE_FIELD, DOC_CONTENT_FIELD])
    with connect_client() as client:
        ensure_collection(client, collection_name)
        collection = client.collections.use(collection_name)
        response = collection.query.hybrid(
            query=query,
            query_properties=query_fields,
            alpha=alpha,
            limit=limit,
            return_metadata=MetadataQuery(score=True),
            return_properties=[
                DOC_TITLE_FIELD,
                DOC_CONTENT_FIELD,
                DOC_SOURCE_FIELD,
                DOC_CREATED_AT_FIELD,
            ],
        )
        return _format_results(response)


def _normalize_search_mode(mode: str | None) -> str:
    if not mode:
        return "semantic"
    value = mode.strip().lower()
    if value in {"semantic", "keyword", "hybrid"}:
        return value
    return "semantic"


def list_documents(
    limit: int = 20,
    offset: int = 0,
    sort_desc: bool = True,
    collection_name: str = WEAVIATE_COLLECTION,
) -> list[dict]:
    with connect_client() as client:
        ensure_collection(client, collection_name)
        collection = client.collections.use(collection_name)
        response = collection.query.fetch_objects(
            limit=limit,
            offset=offset,
            sort=grpc.Sort.by_property(DOC_CREATED_AT_FIELD, ascending=not sort_desc),
            return_properties=[
                DOC_TITLE_FIELD,
                DOC_CONTENT_FIELD,
                DOC_SOURCE_FIELD,
                DOC_CREATED_AT_FIELD,
            ],
        )
        return _format_results(response)


def list_sources(collection_name: str = WEAVIATE_COLLECTION, limit: int = 2000) -> list[dict]:
    sources: dict[str, dict] = {}
    with connect_client() as client:
        ensure_collection(client, collection_name)
        collection = client.collections.use(collection_name)
        offset = 0
        batch = 200
        while offset < limit:
            response = collection.query.fetch_objects(
                limit=batch,
                offset=offset,
                return_properties=[DOC_SOURCE_FIELD, DOC_CREATED_AT_FIELD],
            )
            objects = response.objects or []
            if not objects:
                break
            for obj in objects:
                props = obj.properties or {}
                source = props.get(DOC_SOURCE_FIELD) or ""
                base = source.split("#", 1)[0] if source else ""
                if not base:
                    continue
                created_at = props.get(DOC_CREATED_AT_FIELD) or ""
                entry = sources.setdefault(
                    base,
                    {
                        "source": base,
                        "count": 0,
                        "first_created_at": created_at,
                        "last_created_at": created_at,
                    },
                )
                entry["count"] += 1
                if created_at:
                    if not entry.get("first_created_at") or created_at < entry["first_created_at"]:
                        entry["first_created_at"] = created_at
                    if not entry.get("last_created_at") or created_at > entry["last_created_at"]:
                        entry["last_created_at"] = created_at
            offset += batch
    return sorted(sources.values(), key=lambda item: item["source"])


def delete_source(source: str, collection_name: str = WEAVIATE_COLLECTION) -> int:
    if not source:
        return 0
    to_delete: list[str] = []
    with connect_client() as client:
        ensure_collection(client, collection_name)
        collection = client.collections.use(collection_name)
        offset = 0
        batch = 200
        while True:
            response = collection.query.fetch_objects(
                limit=batch,
                offset=offset,
                return_properties=[DOC_SOURCE_FIELD],
            )
            objects = response.objects or []
            if not objects:
                break
            for obj in objects:
                props = obj.properties or {}
                value = props.get(DOC_SOURCE_FIELD) or ""
                if value.split("#", 1)[0] == source:
                    to_delete.append(str(obj.uuid))
            offset += batch
        deleted = 0
        for doc_id in to_delete:
            if collection.data.delete_by_id(doc_id):
                deleted += 1
        return deleted


def delete_document(doc_id: str, collection_name: str = WEAVIATE_COLLECTION) -> bool:
    with connect_client() as client:
        ensure_collection(client, collection_name)
        collection = client.collections.use(collection_name)
        return bool(collection.data.delete_by_id(doc_id))


def search_txt(query: str, limit: int = 5, collection_name: str = WEAVIATE_COLLECTION) -> list[dict]:
    mode = _normalize_search_mode(WEAVIATE_SEARCH_MODE)
    if mode == "keyword":
        return search_keyword(query=query, limit=limit, collection_name=collection_name)
    if mode == "hybrid":
        return search_hybrid(query=query, limit=limit, collection_name=collection_name)
    return search_semantic(query=query, limit=limit, collection_name=collection_name)


def _rank_result(item: dict) -> float:
    score = item.get("score")
    if isinstance(score, (int, float)):
        return float(score)
    distance = item.get("distance")
    if isinstance(distance, (int, float)):
        return 1.0 / (1.0 + float(distance))
    return 0.0


def search_across_collections(
    query: str,
    limit: int,
    collection_names: Iterable[str],
) -> list[dict]:
    results: list[dict] = []
    for name in collection_names:
        if not name:
            continue
        hits = search_txt(query=query, limit=limit, collection_name=name)
        for hit in hits:
            hit.setdefault("collection", name)
            results.append(hit)
    results.sort(key=_rank_result, reverse=True)
    return results[:limit]
