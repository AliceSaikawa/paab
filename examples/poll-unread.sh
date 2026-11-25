#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "${PAAB_UNREAD_URL:-}" ]; then
	unread_url=$PAAB_UNREAD_URL
elif [ -n "${PAAB_URL:-}" ]; then
	unread_url="${PAAB_URL%/}/unread"
else
	printf '%s\n' "poll-unread.sh: set PAAB_URL or PAAB_UNREAD_URL" >&2
	exit 1
fi

token=""
if [ -n "${PAAB_UNREAD_TOKEN:-}" ]; then
	token=$PAAB_UNREAD_TOKEN
elif [ -n "${PAAB_UNREAD_TOKEN_FILE:-}" ]; then
	if [ ! -r "$PAAB_UNREAD_TOKEN_FILE" ]; then
		printf '%s\n' "poll-unread.sh: token file is not readable: $PAAB_UNREAD_TOKEN_FILE" >&2
		exit 1
	fi
	IFS= read -r token < "$PAAB_UNREAD_TOKEN_FILE" || true
	token=$(printf '%s' "$token" | tr -d ' \t\r\n')
fi

if [ -z "$token" ]; then
	printf '%s\n' "poll-unread.sh: set PAAB_UNREAD_TOKEN or PAAB_UNREAD_TOKEN_FILE" >&2
	exit 1
fi

if ! response=$(curl -fsS -m 10 -H "Authorization: Bearer $token" "$unread_url"); then
	printf '%s\n' "poll-unread.sh: failed to fetch unread count" >&2
	exit 1
fi

compact=$(printf '%s' "$response" | tr -d ' \t\r\n')

case "$compact" in
	'{"unread":'[0-9]'}'|'{"unread":'[0-9]*[0-9]'}')
		unread_count=${compact#'{"unread":'}
		unread_count=${unread_count%'}'}
		case "$unread_count" in
			''|*[!0-9]*|0[0-9]*)
				printf '%s\n' "poll-unread.sh: invalid unread count in response" >&2
				exit 1
				;;
		esac
		;;
	*)
		printf '%s\n' "poll-unread.sh: unexpected response format" >&2
		exit 1
		;;
esac

if [ "$unread_count" -gt 0 ]; then
	wake_cmd=${PAAB_WAKE_CMD:-"$script_dir/wake-agent.sh"}
	exec "$wake_cmd" "$unread_count"
fi
