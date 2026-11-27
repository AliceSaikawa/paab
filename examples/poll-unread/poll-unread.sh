#!/bin/sh
# Poll paab GET /unread and invoke a wake script whenever unread messages exist.
# Requires only POSIX sh, curl, and standard POSIX utilities.
set -eu

cr=$(printf '\r')
tab=$(printf '\t')
nl=$(printf '\nx')
nl=${nl%x}

die() {
	printf 'poll-unread: %s\n' "$1" >&2
	exit 1
}

is_non_neg_int() {
	case "$1" in
		0) return 0 ;;
		[1-9]*)
			case "$1" in
				*[!0-9]*) return 1 ;;
				*) return 0 ;;
			esac
			;;
		*) return 1 ;;
	esac
}

# 1. Validate PAAB_URL and strip trailing slashes.
base_url=${PAAB_URL:-}
while :; do
	case "$base_url" in
		*/) base_url=${base_url%/} ;;
		*) break ;;
	esac
done

if [ -z "$base_url" ]; then
	die "PAAB_URL is required"
fi

case "$base_url" in
	http://?*|https://?*) ;;
	*) die "PAAB_URL must start with http:// or https://" ;;
esac

case "$base_url" in
	*"$nl"*|*"$cr"*|*' '*|*"$tab"*)
		die "PAAB_URL must not contain whitespace or newlines"
		;;
esac

# 2. Validate numeric configuration.
PAAB_CURL_TIMEOUT=${PAAB_CURL_TIMEOUT:-10}
case "$PAAB_CURL_TIMEOUT" in
	''|[!1-9]*|*[!0-9]*)
		die "PAAB_CURL_TIMEOUT must be a positive integer: $PAAB_CURL_TIMEOUT"
		;;
esac

PAAB_WAKE_COOLDOWN_SECONDS=${PAAB_WAKE_COOLDOWN_SECONDS:-0}
if ! is_non_neg_int "$PAAB_WAKE_COOLDOWN_SECONDS"; then
	die "PAAB_WAKE_COOLDOWN_SECONDS must be a non-negative integer: $PAAB_WAKE_COOLDOWN_SECONDS"
fi

# 3. Resolve token from PAAB_UNREAD_TOKEN or PAAB_UNREAD_TOKEN_FILE.
if [ -n "${PAAB_UNREAD_TOKEN:-}" ]; then
	raw_token=$PAAB_UNREAD_TOKEN
elif [ -n "${PAAB_UNREAD_TOKEN_FILE:-}" ]; then
	if [ ! -f "$PAAB_UNREAD_TOKEN_FILE" ] || [ ! -r "$PAAB_UNREAD_TOKEN_FILE" ]; then
		die "PAAB_UNREAD_TOKEN_FILE is not a readable file: $PAAB_UNREAD_TOKEN_FILE"
	fi
	raw_bytes=$(wc -c < "$PAAB_UNREAD_TOKEN_FILE")
	non_nul_bytes=$(LC_ALL=C tr -d '\000' < "$PAAB_UNREAD_TOKEN_FILE" | wc -c)
	if [ "$((raw_bytes))" -ne "$((non_nul_bytes))" ]; then
		die "PAAB_UNREAD_TOKEN_FILE must not contain NUL bytes"
	fi
	raw_token=$(cat -- "$PAAB_UNREAD_TOKEN_FILE"; printf 'x')
	raw_token=${raw_token%x}
else
	die "set PAAB_UNREAD_TOKEN or PAAB_UNREAD_TOKEN_FILE"
fi

token=$raw_token
while :; do
	case "$token" in
		*"$nl") token=${token%"$nl"} ;;
		*"$cr") token=${token%"$cr"} ;;
		*) break ;;
	esac
done

if [ -z "$token" ]; then
	die "unread token is empty"
fi

case "$token" in
	*"$nl"*|*"$cr"*)
		die "unread token must not contain embedded newlines"
		;;
esac

# 4. Resolve state file and wake script paths.
PAAB_STATE_FILE=${PAAB_STATE_FILE:-"${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/paab/unread-count"}

script_path=$0
case "$script_path" in
	*/*) ;;
	*)
		resolved_path=$(command -v -- "$script_path" 2>/dev/null || true)
		if [ -n "$resolved_path" ]; then
			script_path=$resolved_path
		fi
		;;
esac
script_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd)
PAAB_WAKE_SCRIPT=${PAAB_WAKE_SCRIPT:-"${script_dir}/wake.sh"}

# 5. Fetch GET /unread, passing the bearer token via stdin (--config -) so it never appears in ps argv.
escaped_token=$(
	sed 's/\\/\\\\/g; s/"/\\"/g' <<EOF
$token
EOF
)

if ! curl_out=$(
	curl -q -fsS --max-time "$PAAB_CURL_TIMEOUT" --config - -w '\n%{http_code}' -- "${base_url}/unread" <<EOF
header = "Authorization: Bearer ${escaped_token}"
EOF
); then
	die "failed to fetch ${base_url}/unread"
fi

http_code=${curl_out##*"$nl"}
if [ "$http_code" != "200" ]; then
	die "unexpected HTTP status ${http_code} from ${base_url}/unread"
fi

body=${curl_out%"$nl""$http_code"}

# 6. Strictly parse {"unread": <non-negative integer>}.
if ! unread=$(
	LC_ALL=C awk '
	{ text = (NR == 1 ? $0 : text "\n" $0) }
	END {
		if (NR > 0 && text ~ /^[ \t\r\n]*[{][ \t\r\n]*"unread"[ \t\r\n]*:[ \t\r\n]*(0|[1-9][0-9]*)[ \t\r\n]*[}][ \t\r\n]*$/) {
			sub(/^[ \t\r\n]*[{][ \t\r\n]*"unread"[ \t\r\n]*:[ \t\r\n]*/, "", text)
			sub(/[ \t\r\n]*[}][ \t\r\n]*$/, "", text)
			print text
			exit 0
		}
		exit 1
	}' <<EOF
$body
EOF
); then
	die "malformed JSON response from ${base_url}/unread"
fi

if ! is_non_neg_int "$unread"; then
	die "invalid unread count parsed from response"
fi

# 7. Read previous state ("<count> <last_wake_epoch>", or legacy "<count>").
# Default to 0 0 if missing, unreadable, or malformed.
prev=0
last_wake=0
if [ -f "$PAAB_STATE_FILE" ] && [ -r "$PAAB_STATE_FILE" ]; then
	raw_state=$(cat -- "$PAAB_STATE_FILE" 2>/dev/null || true)
	case "$raw_state" in
		*"$cr") raw_state=${raw_state%"$cr"} ;;
	esac
	case "$raw_state" in
		*"$nl"*|*"$cr"*) ;;
		*' '*)
			raw_prev=${raw_state%% *}
			raw_wake=${raw_state#* }
			if is_non_neg_int "$raw_prev" && is_non_neg_int "$raw_wake"; then
				if [ "$raw_prev" -gt 0 ] || [ "$raw_wake" -eq 0 ]; then
					prev=$raw_prev
					last_wake=$raw_wake
				fi
			fi
			;;
		*)
			if is_non_neg_int "$raw_state"; then
				prev=$raw_state
			fi
			;;
	esac
fi

write_state_atomic() {
	target=$1
	value=$2
	state_dir=$(dirname -- "$target")
	mkdir -p -- "$state_dir"
	state_base=$(basename -- "$target")
	case "$state_dir" in
		/) tmp_prefix="/.${state_base}.tmp.$$" ;;
		*) tmp_prefix="${state_dir}/.${state_base}.tmp.$$" ;;
	esac
	tmp_file=""
	attempt=0
	while [ "$attempt" -lt 20 ]; do
		candidate="${tmp_prefix}.${attempt}"
		if (set -C; : > "$candidate") 2>/dev/null; then
			tmp_file=$candidate
			break
		fi
		attempt=$((attempt + 1))
	done
	if [ -z "$tmp_file" ]; then
		die "failed to create temporary state file in ${state_dir}"
	fi
	if ! printf '%s\n' "$value" > "$tmp_file"; then
		rm -f -- "$tmp_file"
		die "failed to write temporary state file: ${tmp_file}"
	fi
	if ! mv -- "$tmp_file" "$target"; then
		rm -f -- "$tmp_file"
		die "failed to update state file: ${target}"
	fi
}

# 8. Wake whenever unread >= 1 (unless suppressed by cooldown), and update state atomically.
if [ "$unread" -eq 0 ]; then
	write_state_atomic "$PAAB_STATE_FILE" "0 0"
else
	if ! now=$(date +%s) || ! is_non_neg_int "$now"; then
		die "failed to read current UNIX timestamp"
	fi

	should_wake=1
	if [ "$PAAB_WAKE_COOLDOWN_SECONDS" -gt 0 ] \
		&& [ "$last_wake" -gt 0 ] \
		&& [ "$now" -ge "$last_wake" ] \
		&& [ "$((now - last_wake))" -lt "$PAAB_WAKE_COOLDOWN_SECONDS" ]; then
		should_wake=0
	fi

	if [ "$should_wake" -eq 1 ]; then
		if [ ! -f "$PAAB_WAKE_SCRIPT" ] || [ ! -x "$PAAB_WAKE_SCRIPT" ]; then
			die "PAAB_WAKE_SCRIPT is not an executable file: $PAAB_WAKE_SCRIPT"
		fi
		case "$PAAB_WAKE_SCRIPT" in
			*/*) wake_exec=$PAAB_WAKE_SCRIPT ;;
			*) wake_exec="./$PAAB_WAKE_SCRIPT" ;;
		esac
		if ! PAAB_UNREAD_COUNT="$unread" PAAB_PREV_UNREAD_COUNT="$prev" "$wake_exec" "$unread" "$prev"; then
			die "wake script exited with non-zero status: $PAAB_WAKE_SCRIPT"
		fi
		write_state_atomic "$PAAB_STATE_FILE" "${unread} ${now}"
	else
		write_state_atomic "$PAAB_STATE_FILE" "${unread} ${last_wake}"
	fi
fi
