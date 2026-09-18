#!/bin/sh
set -e
mkdir -p "$(dirname "${DATABASE_PATH:-/app/backend/data/compliance-monitor.db}")"
exec "$@"
