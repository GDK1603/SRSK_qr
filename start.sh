#!/usr/bin/env bash
# ==============================================================
# Sai Krishna Graphics & Offset - Kiosk Dev Server Starter
# ==============================================================
set -e

echo "🚀 Starting Sai Krishna Graphics Kiosk Server on port 3000..."

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "📦 Installing project dependencies..."
  npm install
fi

# Run the dev server with tsx backend
echo "⚡ Server launching at http://localhost:3000"
npm run dev
