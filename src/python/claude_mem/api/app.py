"""
FastAPI Application

Main application with lifespan management for database connections.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from claude_recall.config import get_config
from claude_recall.storage.tiered.manager import get_tiered_storage

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan manager.

    Initializes storage on startup, closes on shutdown.
    """
    # Startup
    logger.info("Starting claude-recall tiered storage service...")

    # Initialize tiered storage
    storage = get_tiered_storage()
    await storage.initialize()

    logger.info("claude-recall service ready")

    yield

    # Shutdown
    logger.info("Shutting down claude-recall service...")
    await storage.close()
    logger.info("claude-recall service stopped")


# Create FastAPI app
app = FastAPI(
    title="claude-recall Tiered Storage",
    description="AI-powered memory system with tiered storage (Redis + PostgreSQL)",
    version="1.0.0",
    lifespan=lifespan,
)

# Add CORS middleware
config = get_config()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import and include routes
from claude_recall.api.routes import router
app.include_router(router)
