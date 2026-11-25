#!/bin/sh
set -eu

# Replaceable wake adapter invoked by poll-unread.sh when unread messages > 0.
# Receives the unread count as $1.
# Replace the placeholder command below with your agent's wake mechanism, or set
# PAAB_WAKE_CMD to point to your own executable script.

unread_count=${1:-}
case "$unread_count" in
	''|*[!0-9]*)
		printf '%s\n' "Usage: wake-agent.sh <unread-count>" >&2
		exit 1
		;;
esac

# Operator customization examples (uncomment and adapt one):
#
# 1. Local agent CLI (ask the agent to call check_inbox):
#    exec my-agent-cli run --prompt "Call paab check_inbox ($unread_count unread)."
#
# 2. Local daemon HTTP hook (for example, a Muse or Grok Bot companion service):
#    exec curl -fsS -m 5 -X POST http://127.0.0.1:8080/wake \
#        -H "Content-Type: application/json" \
#        -d "{\"unread\":$unread_count}"

printf 'paab: %s unread message(s) waiting; customize %s or set PAAB_WAKE_CMD to wake your agent\n' \
	"$unread_count" "$0"
