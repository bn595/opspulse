#!/usr/bin/env sh
# Start opspulse. Requires Node.js 18+ on PATH.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required: https://nodejs.org"; exit 1; }
exec node src/server.js "$@"
