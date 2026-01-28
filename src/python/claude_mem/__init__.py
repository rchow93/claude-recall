"""
Claude-Recall Tiered Memory Storage

Two-tier architecture for fast, scalable persistent memory:
- Hot Tier (Redis): Fast retrieval (~1-5ms), recent data (48h)
- Cold Tier (PostgreSQL): Long-term storage (20-day retention), hybrid search
"""

__version__ = "1.0.0"
