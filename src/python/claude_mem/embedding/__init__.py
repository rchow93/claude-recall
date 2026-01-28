"""Embedding service for generating vector embeddings."""

from claude_recall.embedding.service import (
    EmbeddingService,
    get_embedding_service,
    generate_embedding,
    generate_embeddings,
)

__all__ = [
    "EmbeddingService",
    "get_embedding_service",
    "generate_embedding",
    "generate_embeddings",
]
