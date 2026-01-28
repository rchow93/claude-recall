"""
Data models for the tiered storage system.

Uses Pydantic for validation and serialization.
"""

from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


class ObservationType(str, Enum):
    """Types of observations that can be stored."""

    DECISION = "decision"
    BUGFIX = "bugfix"
    FEATURE = "feature"
    REFACTOR = "refactor"
    DISCOVERY = "discovery"
    CHANGE = "change"


class StoredObservation(BaseModel):
    """An observation stored in the database."""

    id: int
    memory_session_id: str
    project: str
    type: ObservationType
    title: Optional[str] = None
    subtitle: Optional[str] = None
    facts: Optional[list[str]] = None
    narrative: Optional[str] = None
    concepts: Optional[list[str]] = None
    files_read: Optional[list[str]] = None
    files_modified: Optional[list[str]] = None
    prompt_number: Optional[int] = None
    discovery_tokens: int = 0
    embedding: Optional[list[float]] = None
    created_at: datetime
    created_at_epoch: int


class ObservationInput(BaseModel):
    """Input for creating a new observation."""

    memory_session_id: str
    project: str
    type: ObservationType
    title: Optional[str] = None
    subtitle: Optional[str] = None
    facts: Optional[list[str]] = None
    narrative: Optional[str] = None
    concepts: Optional[list[str]] = None
    files_read: Optional[list[str]] = None
    files_modified: Optional[list[str]] = None
    prompt_number: Optional[int] = None
    discovery_tokens: int = 0
    embedding: Optional[list[float]] = None
    created_at_epoch: Optional[int] = None


class StoredSessionSummary(BaseModel):
    """A session summary stored in the database."""

    id: int
    memory_session_id: str
    project: str
    request: Optional[str] = None
    investigated: Optional[str] = None
    learned: Optional[str] = None
    completed: Optional[str] = None
    next_steps: Optional[str] = None
    notes: Optional[str] = None
    files_read: Optional[list[str]] = None
    files_edited: Optional[list[str]] = None
    prompt_number: Optional[int] = None
    discovery_tokens: int = 0
    embedding: Optional[list[float]] = None
    created_at: datetime
    created_at_epoch: int


class SessionSummaryInput(BaseModel):
    """Input for creating a session summary."""

    memory_session_id: str
    project: str
    request: Optional[str] = None
    investigated: Optional[str] = None
    learned: Optional[str] = None
    completed: Optional[str] = None
    next_steps: Optional[str] = None
    notes: Optional[str] = None
    files_read: Optional[list[str]] = None
    files_edited: Optional[list[str]] = None
    prompt_number: Optional[int] = None
    discovery_tokens: int = 0
    embedding: Optional[list[float]] = None
    created_at_epoch: Optional[int] = None


class StoredWeeklySummary(BaseModel):
    """A weekly summary for hierarchical consolidation."""

    id: int
    project: str
    week_start: str  # ISO date YYYY-MM-DD
    summary_text: str
    key_topics: Optional[list[str]] = None
    embedding: Optional[list[float]] = None
    source_session_ids: list[int] = Field(default_factory=list)
    created_at: datetime
    created_at_epoch: int


class WeeklySummaryInput(BaseModel):
    """Input for creating a weekly summary."""

    project: str
    week_start: str
    summary_text: str
    key_topics: Optional[list[str]] = None
    embedding: Optional[list[float]] = None
    source_session_ids: list[int] = Field(default_factory=list)


class StoredProjectFact(BaseModel):
    """A project fact (stable knowledge)."""

    id: int
    project: str
    fact_text: str
    fact_type: str = "general"
    confidence: float = 1.0
    embedding: Optional[list[float]] = None
    created_at: datetime
    created_at_epoch: int


class ProjectFactInput(BaseModel):
    """Input for creating a project fact."""

    project: str
    fact_text: str
    fact_type: str = "general"
    confidence: float = 1.0
    embedding: Optional[list[float]] = None


class HybridSearchOptions(BaseModel):
    """Options for hybrid search queries."""

    limit: int = 10
    project: Optional[str] = None
    since_epoch: Optional[int] = None
    until_epoch: Optional[int] = None
    types: Optional[list[ObservationType]] = None
    min_score: Optional[float] = None


class SearchResult(BaseModel):
    """A search result with score and source."""

    id: int
    type: str  # "observation", "summary", "fact"
    title: str
    content: str
    score: float
    rank: int
    source: str  # "hot", "cold"
    metadata: Optional[dict] = None


class RAGQueryResult(BaseModel):
    """Result from a RAG query."""

    query: str
    results: list[SearchResult] = Field(default_factory=list)
    total_results: int = 0
    hot_tier_hits: int = 0
    cold_tier_hits: int = 0
    sources_used: list[str] = Field(default_factory=list)


class QueryOptions(BaseModel):
    """Options for querying observations."""

    project: Optional[str] = None
    types: Optional[list[ObservationType]] = None
    concepts: Optional[list[str]] = None
    files: Optional[list[str]] = None
    limit: int = 100
    offset: int = 0
    since_epoch: Optional[int] = None
    until_epoch: Optional[int] = None
    order: str = "desc"  # "asc" or "desc"


class CacheWarmingStats(BaseModel):
    """Statistics from cache warming."""

    observations_warmed: int = 0
    facts_warmed: int = 0
    duration_ms: int = 0


class SummarizationStats(BaseModel):
    """Statistics from summarization run."""

    sessions_consolidated: int = 0
    weekly_consolidated: int = 0
    facts_extracted: int = 0
    duration_ms: int = 0
