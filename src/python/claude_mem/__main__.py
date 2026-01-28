"""
Main entry point for running the claude-recall service.

Usage:
    python -m claude_recall              # Run API server
    python -m claude_recall --workers    # Run with background workers
"""

import argparse
import asyncio
import logging
import sys

import uvicorn

from claude_recall.config import get_config


def setup_logging():
    """Configure logging."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
        ],
    )


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description="claude-recall tiered storage service")
    parser.add_argument(
        "--host",
        default=None,
        help="Host to bind to (default: from config)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Port to bind to (default: from config)",
    )
    parser.add_argument(
        "--workers",
        action="store_true",
        help="Run background workers (summarization, retention)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development",
    )
    args = parser.parse_args()

    setup_logging()
    config = get_config()

    host = args.host or config.server_host
    port = args.port or config.server_port

    if args.workers:
        # Run with background workers
        asyncio.run(run_with_workers(host, port))
    else:
        # Run API server only
        uvicorn.run(
            "claude_recall.api.app:app",
            host=host,
            port=port,
            reload=args.reload,
        )


async def run_with_workers(host: str, port: int):
    """Run API server with background workers."""
    import uvicorn
    from claude_recall.workers import SummarizationWorker, RetentionWorker
    from claude_recall.storage.tiered.manager import get_tiered_storage

    # Initialize storage
    storage = get_tiered_storage()
    await storage.initialize()

    # Start workers
    summarization = SummarizationWorker()
    retention = RetentionWorker()

    # Create tasks
    tasks = [
        asyncio.create_task(summarization.start()),
        asyncio.create_task(retention.start()),
    ]

    # Run server
    config = uvicorn.Config(
        "claude_recall.api.app:app",
        host=host,
        port=port,
        loop="asyncio",
    )
    server = uvicorn.Server(config)

    try:
        await server.serve()
    finally:
        # Stop workers
        summarization.stop()
        retention.stop()

        # Cancel tasks
        for task in tasks:
            task.cancel()

        # Cleanup
        await storage.close()


if __name__ == "__main__":
    main()
