#!/bin/bash
# =============================================================================
# claude-recall Tiered Storage - Uninstall Script (macOS)
# =============================================================================

set -e

PLIST_NAME="com.claude-recall.tiered-storage.plist"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"

echo "=========================================="
echo "claude-recall Tiered Storage Uninstaller"
echo "=========================================="
echo ""

# -----------------------------------------------------------------------------
# Stop and remove launchd service
# -----------------------------------------------------------------------------
echo "[1/3] Stopping service..."

if [ -f "$LAUNCHD_DIR/$PLIST_NAME" ]; then
    launchctl unload "$LAUNCHD_DIR/$PLIST_NAME" 2>/dev/null || true
    rm "$LAUNCHD_DIR/$PLIST_NAME"
    echo "       Service stopped and removed"
else
    echo "       Service not installed"
fi

# -----------------------------------------------------------------------------
# Stop Docker containers
# -----------------------------------------------------------------------------
echo ""
echo "[2/3] Stopping Docker containers..."

cd "$INSTALL_DIR"
docker compose down 2>/dev/null || true
echo "       Containers stopped"

# -----------------------------------------------------------------------------
# Ask about data
# -----------------------------------------------------------------------------
echo ""
echo "[3/3] Data cleanup..."
echo ""
read -p "Delete all data (PostgreSQL + Redis volumes)? [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    docker compose down -v 2>/dev/null || true
    echo "       Data volumes deleted"
else
    echo "       Data preserved (run 'docker compose down -v' to delete)"
fi

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------
echo ""
echo "=========================================="
echo "Uninstall Complete"
echo "=========================================="
echo ""
echo "The Python package is still installed. To remove it:"
echo "  pip3 uninstall claude-recall-tiered"
echo ""
echo "Log files are in ~/.claude-recall/logs/"
echo ""
