#!/bin/sh
set -euo pipefail

# Wait for dockerd to be ready
tries=0
until docker version >/dev/null 2>&1; do
  tries=$((tries+1))
  if [ "$tries" -gt 50 ]; then
    echo "dockerd did not become ready in time" >&2
    exit 1
  fi
  sleep 0.2
done

# Avoid the development server's reverse lookup of the runtime's long hostname.
exec /opt/venv/bin/gunicorn --chdir /opt/app --bind 0.0.0.0:8080 --threads 4 app:app
