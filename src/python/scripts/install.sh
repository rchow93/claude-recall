#!/bin/bash
# =============================================================================
# claude-recall Tiered Storage - Install Script (macOS)
# =============================================================================
# This script:
# 1. Starts PostgreSQL and Redis via Docker (with auto-restart)
# 2. Installs the Python service as a launchd daemon (auto-starts on boot)
# 3. Pulls the Ollama embedding model
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$HOME/.claude-recall/logs"
PLIST_NAME="com.claude-recall.tiered-storage.plist"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"

echo "=========================================="
echo "claude-recall Tiered Storage Installer"
echo "=========================================="
echo ""
echo "Install directory: $INSTALL_DIR"
echo ""

# -----------------------------------------------------------------------------
# Check prerequisites
# -----------------------------------------------------------------------------
echo "[1/6] Checking prerequisites..."

if ! command -v docker &> /dev/null; then
    echo "ERROR: Docker is not installed. Please install Docker Desktop first."
    echo "       https://www.docker.com/products/docker-desktop"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo "ERROR: Docker is not running. Please start Docker Desktop first."
    exit 1
fi

if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is not installed."
    exit 1
fi

echo "       Docker: OK"
echo "       Python: $(python3 --version)"

# -----------------------------------------------------------------------------
# Create directories
# -----------------------------------------------------------------------------
echo ""
echo "[2/6] Creating directories..."

mkdir -p "$LOG_DIR"
mkdir -p "$HOME/.claude-recall"

echo "       Log directory: $LOG_DIR"

# -----------------------------------------------------------------------------
# Setup environment
# -----------------------------------------------------------------------------
echo ""
echo "[3/6] Setting up environment..."

if [ ! -f "$INSTALL_DIR/.env" ]; then
    cp "$INSTALL_DIR/.env.sample" "$INSTALL_DIR/.env"
    echo "       Created .env from .env.sample"
else
    echo "       .env already exists"
fi

# -----------------------------------------------------------------------------
# Start Docker containers
# -----------------------------------------------------------------------------
echo ""
echo "[4/6] Starting Docker containers..."

cd "$INSTALL_DIR"
docker compose up -d postgres redis

echo "       PostgreSQL: localhost:5432"
echo "       Redis: localhost:6379"

# Wait for containers to be healthy
echo "       Waiting for containers to be ready..."
sleep 5

# -----------------------------------------------------------------------------
# Install Python package
# -----------------------------------------------------------------------------
echo ""
echo "[5/6] Installing Python package..."

cd "$INSTALL_DIR"
pip3 install -e . --quiet

echo "       Python package installed"

# -----------------------------------------------------------------------------
# Setup launchd service
# -----------------------------------------------------------------------------
echo ""
echo "[6/6] Setting up auto-start service..."

mkdir -p "$LAUNCHD_DIR"

# Generate plist with correct paths
sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$SCRIPT_DIR/com.claude-mem.plist" > "$LAUNCHD_DIR/$PLIST_NAME"

# Unload if already loaded
launchctl unload "$LAUNCHD_DIR/$PLIST_NAME" 2>/dev/null || true

# Load the service
launchctl load "$LAUNCHD_DIR/$PLIST_NAME"

echo "       Service installed: $PLIST_NAME"

# -----------------------------------------------------------------------------
# Check Ollama
# -----------------------------------------------------------------------------
echo ""
echo "[Optional] Checking Ollama..."

if command -v ollama &> /dev/null; then
    echo "       Ollama found. Pulling embedding model..."
    ollama pull nomic-embed-text || echo "       Warning: Could not pull model. Run 'ollama pull nomic-embed-text' manually."
else
    echo "       Ollama not found. Install from https://ollama.com"
    echo "       Then run: ollama pull nomic-embed-text"
    echo "       (The service will use local embeddings as fallback)"
fi

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------
echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""
echo "The service is now running and will auto-start on boot."
echo ""
echo "API endpoint: http://localhost:37778"
echo "Health check: curl http://localhost:37778/health"
echo ""
echo "Logs:"
echo "  stdout: $LOG_DIR/claude-recall.log"
echo "  stderr: $LOG_DIR/claude-recall.error.log"
echo ""
echo "Commands:"
echo "  Stop:    launchctl unload ~/Library/LaunchAgents/$PLIST_NAME"
echo "  Start:   launchctl load ~/Library/LaunchAgents/$PLIST_NAME"
echo "  Restart: launchctl kickstart -k gui/\$(id -u)/com.claude-recall.tiered-storage"
echo "  Status:  launchctl list | grep claude-recall"
echo ""
