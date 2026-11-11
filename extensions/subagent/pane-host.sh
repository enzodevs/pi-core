#!/bin/sh

channel=$1
token=$2
shift 2

record_exit() {
	code=$1
	temporary="$channel/exit.$$.tmp"
	printf '{"version":1,"token":"%s","code":%s}\n' "$token" "$code" >"$temporary" &&
		chmod 600 "$temporary" &&
		mv -f "$temporary" "$channel/exit.json"
}

trap 'record_exit "$?"' EXIT
"$@"
code=$?
trap - EXIT
# Persist the Pi exit before closing its terminal can terminate this host.
if ! record_exit "$code"; then
	printf '%s\n' 'Pi child terminal retained: exit receipt could not be saved.' >&2
	exit "$code"
fi
if [ "$code" -eq 0 ] && [ "${PI_CORE_SUBAGENT_HERDR:-}" = 1 ] && [ -n "${PI_CORE_SUBAGENT_NODE:-}" ]; then
	exec "$PI_CORE_SUBAGENT_NODE" "$(dirname "$0")/herdr-cleanup.mjs" "$channel" "$token"
fi
exit "$code"
