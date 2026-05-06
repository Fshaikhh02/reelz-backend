#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Reelz Backend — Start Script
#  Usage:
#    ./start.sh          → production (node)
#    ./start.sh dev      → dev mode with auto-reload (nodemon)
# ─────────────────────────────────────────────────────────────

set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PORT="${PORT:-3000}"

echo -e "${GREEN}🎬 Reelz Backend${NC}"
echo "────────────────────────────────"

# 1. Check Node.js
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Install it from https://nodejs.org${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Node $(node -v)${NC}"

# 2. Install dependencies if node_modules is missing or package.json changed
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
  echo -e "${YELLOW}⟳ Installing dependencies...${NC}"
  npm install --silent
  echo -e "${GREEN}✓ Dependencies installed${NC}"
else
  echo -e "${GREEN}✓ Dependencies up to date${NC}"
fi

# 3. Check if port is already in use
if lsof -Pi ":$PORT" -sTCP:LISTEN -t &>/dev/null 2>&1; then
  echo -e "${YELLOW}⚠ Port $PORT is already in use.${NC}"
  read -r -p "  Kill existing process and restart? [y/N] " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    lsof -ti ":$PORT" | xargs kill -9 2>/dev/null || true
    sleep 1
    echo -e "${GREEN}✓ Cleared port $PORT${NC}"
  else
    echo -e "${RED}Exiting. The server may already be running.${NC}"
    exit 1
  fi
fi

echo "────────────────────────────────"

# 4. Start the server
if [ "$1" = "dev" ]; then
  echo -e "${GREEN}▶ Starting in DEV mode (auto-reload on file changes)${NC}"
  echo -e "  URL: ${YELLOW}http://localhost:$PORT${NC}"
  echo "────────────────────────────────"
  npx nodemon src/server.js
else
  echo -e "${GREEN}▶ Starting server on port $PORT${NC}"
  echo -e "  URL:    ${YELLOW}http://localhost:$PORT${NC}"
  echo -e "  Health: ${YELLOW}http://localhost:$PORT/health${NC}"
  echo "────────────────────────────────"
  node src/server.js &
  SERVER_PID=$!

  # Wait for the server to accept connections
  echo -n "  Waiting for server"
  for i in $(seq 1 20); do
    sleep 0.5
    if curl -sf "http://localhost:$PORT/health" &>/dev/null; then
      echo ""
      echo -e "${GREEN}✓ Server is up! (PID $SERVER_PID)${NC}"
      break
    fi
    echo -n "."
    if [ "$i" -eq 20 ]; then
      echo ""
      echo -e "${RED}✗ Server did not respond after 10s. Check logs above.${NC}"
      kill $SERVER_PID 2>/dev/null
      exit 1
    fi
  done

  echo ""
  echo -e "  Press ${YELLOW}Ctrl+C${NC} to stop."
  echo "────────────────────────────────"
  wait $SERVER_PID
fi
