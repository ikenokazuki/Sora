#!/usr/bin/env bash
set -e
nix-shell -p bun chromium --run "ALLOW_LOCAL_FETCH=true CHROME_PATH=\$(which chromium) bun test --timeout 30000"
