#!/usr/bin/env bash
# One command to run the app.
#   ./run.sh          install deps if needed, build the front end, serve on http://127.0.0.1:8000
#   ./run.sh dev      same, but with hot reload (Vite on :5173 proxying the API on :8000)
#   ./run.sh test     run the engine self-check
set -euo pipefail
cd "$(dirname "$0")"

export PORT="${PORT:-8000}"

need() { command -v "$1" >/dev/null || { echo "Missing '$1'. $2" >&2; exit 1; }; }
need uv "Install: https://docs.astral.sh/uv/"
need npm "Install Node.js 20+."

uv sync --quiet
git config core.hooksPath .githooks 2>/dev/null || true  # pre-commit runs the tests
[ -d web/node_modules ] || (cd web && npm ci --silent)

case "${1:-}" in
  test)
    exec uv run python test_model.py
    ;;
  dev)
    trap 'kill 0' EXIT
    uv run uvicorn server:app --port "$PORT" --reload &
    (cd web && npm run dev)
    ;;
  *)
    # rebuild only when front-end sources are newer than the last build
    if [ ! -f web/dist/index.html ] || [ -n "$(find web/src web/index.html -newer web/dist/index.html -print -quit)" ]; then
      (cd web && npm run build --silent)
    fi
    echo "Open http://127.0.0.1:$PORT"
    exec uv run uvicorn server:app --port "$PORT"
    ;;
esac
