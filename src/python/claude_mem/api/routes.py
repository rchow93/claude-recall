"""
API Routes

REST endpoints for RAG queries, observations, and storage management.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from claude_recall.models import (
    ObservationInput,
    SessionSummaryInput,
    QueryOptions,
    HybridSearchOptions,
    ObservationType,
    RAGQueryResult,
    SearchResult,
)
from claude_recall.storage.tiered.manager import get_tiered_storage
from claude_recall.storage.tiered.query_router import get_query_router
from claude_recall.storage.tiered.cache_warmer import get_cache_warmer
from claude_recall.embedding import generate_embedding

logger = logging.getLogger(__name__)
router = APIRouter()


# Request/Response models
class RAGQueryRequest(BaseModel):
    """Request for RAG context retrieval."""
    query: str
    project: Optional[str] = None
    limit: int = 10
    include_summaries: bool = True


class WarmCacheRequest(BaseModel):
    """Request to warm cache for a project."""
    project: str
    files: Optional[list[str]] = None
    concepts: Optional[list[str]] = None


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    hot_tier: bool
    cold_tier: bool


# Health endpoints
@router.get("/health", response_model=HealthResponse)
async def health_check():
    """Check service health and tier availability."""
    storage = get_tiered_storage()

    hot_available = await storage.is_hot_tier_available()
    cold_available = True  # PostgreSQL is required

    return HealthResponse(
        status="healthy" if cold_available else "degraded",
        hot_tier=hot_available,
        cold_tier=cold_available,
    )


# RAG endpoints
@router.post("/rag/query", response_model=RAGQueryResult)
async def query_rag_context(request: RAGQueryRequest):
    """
    Query for RAG context based on user prompt.

    This is the primary endpoint for per-prompt context retrieval.
    """
    try:
        # Generate embedding for query
        embedding = await generate_embedding(request.query)

        # Build search options
        options = HybridSearchOptions(
            limit=request.limit,
            project=request.project,
        )

        # Execute tiered query
        router_instance = get_query_router()
        result = await router_instance.query(request.query, embedding, options)

        return result

    except Exception as e:
        logger.error(f"RAG query failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/rag/warm")
async def warm_cache(request: WarmCacheRequest):
    """
    Warm the cache for a project.

    Call this on session start for optimal performance.
    """
    try:
        warmer = get_cache_warmer()

        # Base warming
        count = await warmer.warm_for_project(request.project)

        # Additional warming based on files
        if request.files:
            count += await warmer.warm_for_files(request.project, request.files)

        # Additional warming based on concepts
        if request.concepts:
            count += await warmer.warm_for_concepts(request.project, request.concepts)

        return {"cached": count, "project": request.project}

    except Exception as e:
        logger.error(f"Cache warming failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Observation endpoints
@router.post("/observations")
async def store_observation(observation: ObservationInput):
    """Store a new observation."""
    try:
        # Generate embedding if not provided
        if not observation.embedding:
            text = f"{observation.title or ''} {observation.narrative or ''}"
            observation.embedding = await generate_embedding(text)

        storage = get_tiered_storage()
        stored = await storage.store_observation(observation)

        return {"id": stored.id, "memory_session_id": stored.memory_session_id}

    except Exception as e:
        logger.error(f"Failed to store observation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/observations/{obs_id}")
async def get_observation(obs_id: int):
    """Get an observation by ID."""
    storage = get_tiered_storage()
    obs = await storage.get_observation(obs_id)

    if not obs:
        raise HTTPException(status_code=404, detail="Observation not found")

    return obs


@router.get("/observations")
async def get_recent_observations(
    project: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    types: Optional[str] = Query(None, description="Comma-separated types"),
):
    """Get recent observations with optional filtering."""
    storage = get_tiered_storage()

    type_list = None
    if types:
        type_list = [ObservationType(t.strip()) for t in types.split(",")]

    options = QueryOptions(
        project=project,
        limit=limit,
        offset=offset,
        types=type_list,
    )

    observations = await storage.get_recent_observations(options)
    return {"observations": observations, "count": len(observations)}


@router.delete("/observations/{obs_id}")
async def delete_observation(obs_id: int):
    """Delete an observation."""
    storage = get_tiered_storage()
    deleted = await storage.delete_observation(obs_id)

    if not deleted:
        raise HTTPException(status_code=404, detail="Observation not found")

    return {"deleted": True, "id": obs_id}


# Summary endpoints
@router.post("/summaries")
async def store_summary(summary: SessionSummaryInput):
    """Store a session summary."""
    try:
        # Generate embedding if not provided
        if not summary.embedding:
            text = f"{summary.request or ''} {summary.learned or ''} {summary.completed or ''}"
            summary.embedding = await generate_embedding(text)

        storage = get_tiered_storage()
        stored = await storage.store_summary(summary)

        return {"id": stored.id, "memory_session_id": stored.memory_session_id}

    except Exception as e:
        logger.error(f"Failed to store summary: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/summaries/{summary_id}")
async def get_summary(summary_id: int):
    """Get a summary by ID."""
    storage = get_tiered_storage()
    summary = await storage.get_summary(summary_id)

    if not summary:
        raise HTTPException(status_code=404, detail="Summary not found")

    return summary


@router.get("/summaries/session/{memory_session_id}")
async def get_summary_by_session(memory_session_id: str):
    """Get the summary for a session."""
    storage = get_tiered_storage()
    summary = await storage.get_summary_by_session(memory_session_id)

    if not summary:
        raise HTTPException(status_code=404, detail="Summary not found")

    return summary


# Search endpoints
@router.get("/search/concepts")
async def search_by_concepts(
    concepts: str = Query(..., description="Comma-separated concepts"),
    project: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
):
    """Search observations by concept overlap."""
    concept_list = [c.strip() for c in concepts.split(",")]

    options = HybridSearchOptions(
        project=project,
        limit=limit,
    )

    router_instance = get_query_router()
    results = await router_instance.search_by_concepts(concept_list, options)

    return {"results": results, "count": len(results)}


@router.get("/search/files")
async def search_by_files(
    files: str = Query(..., description="Comma-separated file paths"),
    project: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
):
    """Search observations by file involvement."""
    file_list = [f.strip() for f in files.split(",")]

    options = HybridSearchOptions(
        project=project,
        limit=limit,
    )

    router_instance = get_query_router()
    results = await router_instance.search_by_files(file_list, options)

    return {"results": results, "count": len(results)}
