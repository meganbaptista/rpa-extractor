#!/bin/zsh
# Scratch runner: supplies the PROJECT's Anthropic key, not Netlify's AI
# Gateway JWT, which shadows it under `netlify dev:exec`. Hand over for deletion.
cd "$(dirname "$0")"
K="$(netlify env:list --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["ANTHROPIC_API_KEY"])')"
export ANTHROPIC_API_KEY="$K"
exec node "$@"
