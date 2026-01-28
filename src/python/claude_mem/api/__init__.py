"""FastAPI application and routes."""

from claude_recall.api.app import app, lifespan
from claude_recall.api.routes import router

__all__ = ["app", "lifespan", "router"]
