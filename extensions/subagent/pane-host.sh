#!/bin/sh

channel=$1
token=$2
shift 2

record_exit() {
	code=$?
	temporary="$channel/exit.$$.tmp"
	printf '{"version":1,"token":"%s","code":%s}\n' "$token" "$code" >"$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$channel/exit.json"
}

trap record_exit EXIT
"$@"
