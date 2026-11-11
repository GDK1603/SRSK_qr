#!/usr/bin/env bash
# ==============================================================
# Sai Krishna Graphics & Offset - Check Print Spool Queue
# ==============================================================
SERVER_URL="${SERVER_URL:-http://localhost:3000}"

echo "🖨️ Querying Shop Printer Spool Queue at $SERVER_URL/api/print/queue..."
curl -s "$SERVER_URL/api/print/queue"
echo ""
