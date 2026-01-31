import weaviate_utils


def main() -> None:
    seed_collection = weaviate_utils.seed_collection_name()
    with weaviate_utils.connect_client() as client:
        if not client.collections.exists(seed_collection):
            print(f"Seed collection not found: {seed_collection}")
            return
        client.collections.delete(seed_collection)
    print(f"Deleted seed collection: {seed_collection}")


if __name__ == "__main__":
    main()
