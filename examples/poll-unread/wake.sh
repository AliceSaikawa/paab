#!/bin/sh
# Sample wake handler invoked by poll-unread.sh when the unread count increases.
#
# Arguments:
#   $1 - current unread count (also available as PAAB_UNREAD_COUNT)
#   $2 - previous unread count (also available as PAAB_PREV_UNREAD_COUNT)
#
# To integrate with a specific agent product without editing poll-unread.sh,
# set PAAB_WAKE_SCRIPT=/path/to/your-wake.sh (chmod 755) or replace this file.
#
# Examples:
#   - OpenClaw / local agent CLI: trigger a turn instructing the agent to call check_inbox.
#   - Headless runner / local hook: post to a local webhook or launch your agent command.
set -eu

unread=${1:-${PAAB_UNREAD_COUNT:-0}}
prev=${2:-${PAAB_PREV_UNREAD_COUNT:-0}}

printf '[paab] new unread messages: %s (previous: %s)\n' "$unread" "$prev"
