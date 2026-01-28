# Python 3.11+ for best performance
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

# Copy application code
COPY claude_recall/ claude_recall/

# Expose port
EXPOSE 37778

# Run with workers
CMD ["python", "-m", "claude_recall", "--workers"]
