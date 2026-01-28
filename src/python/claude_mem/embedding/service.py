"""
Embedding Service

Generates vector embeddings using Ollama or local models.
"""

import logging
from typing import Optional

import httpx

from claude_recall.config import get_config

logger = logging.getLogger(__name__)


class EmbeddingService:
    """
    Embedding service with Ollama and local model support.

    Primary: Ollama API (nomic-embed-text, 768 dimensions)
    Fallback: sentence-transformers (local)
    """

    def __init__(self):
        self.config = get_config()
        self._local_model = None
        self._use_local = self.config.use_local_embeddings

    async def _get_ollama_embedding(self, text: str) -> list[float]:
        """Get embedding from Ollama API."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.config.ollama.host}/api/embeddings",
                json={
                    "model": self.config.ollama.embedding_model,
                    "prompt": text,
                },
            )
            response.raise_for_status()
            data = response.json()
            return data["embedding"]

    def _get_local_embedding(self, text: str) -> list[float]:
        """Get embedding from local sentence-transformers model."""
        if self._local_model is None:
            from sentence_transformers import SentenceTransformer

            self._local_model = SentenceTransformer("nomic-ai/nomic-embed-text-v1.5")
            logger.info("Loaded local embedding model")

        embedding = self._local_model.encode(text, convert_to_numpy=True)
        return embedding.tolist()

    async def embed(self, text: str) -> list[float]:
        """
        Generate embedding for a single text.

        Tries Ollama first, falls back to local model.
        """
        if not text or not text.strip():
            # Return zero vector for empty text
            return [0.0] * self.config.ollama.embedding_dimension

        if self._use_local:
            return self._get_local_embedding(text)

        try:
            return await self._get_ollama_embedding(text)
        except Exception as e:
            logger.warning(f"Ollama embedding failed, using local: {e}")
            self._use_local = True
            return self._get_local_embedding(text)

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """
        Generate embeddings for multiple texts.

        For efficiency, uses batch processing when available.
        """
        if self._use_local:
            return self._embed_batch_local(texts)

        # Ollama doesn't have native batch support, process sequentially
        results = []
        for text in texts:
            embedding = await self.embed(text)
            results.append(embedding)
        return results

    def _embed_batch_local(self, texts: list[str]) -> list[list[float]]:
        """Batch embed using local model."""
        if self._local_model is None:
            from sentence_transformers import SentenceTransformer

            self._local_model = SentenceTransformer("nomic-ai/nomic-embed-text-v1.5")

        embeddings = self._local_model.encode(texts, convert_to_numpy=True)
        return embeddings.tolist()

    async def is_available(self) -> bool:
        """Check if embedding service is available."""
        if self._use_local:
            try:
                self._get_local_embedding("test")
                return True
            except Exception:
                return False

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.config.ollama.host}/api/tags")
                return response.status_code == 200
        except Exception:
            # Try local as fallback
            try:
                self._get_local_embedding("test")
                self._use_local = True
                return True
            except Exception:
                return False


# Singleton instance
_service: Optional[EmbeddingService] = None


def get_embedding_service() -> EmbeddingService:
    """Get the global embedding service."""
    global _service
    if _service is None:
        _service = EmbeddingService()
    return _service


async def generate_embedding(text: str) -> list[float]:
    """Generate embedding for a single text."""
    service = get_embedding_service()
    return await service.embed(text)


async def generate_embeddings(texts: list[str]) -> list[list[float]]:
    """Generate embeddings for multiple texts."""
    service = get_embedding_service()
    return await service.embed_batch(texts)
