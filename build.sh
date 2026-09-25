#!/usr/bin/env bash
# Builds dist/geoblocker.zip, ready for WordPress Admin → Plugins → Add New → Upload Plugin.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/geoblocker.zip
zip -rq dist/geoblocker.zip geoblocker -x '*.DS_Store' -x '*/.git*'
echo "Built dist/geoblocker.zip"
