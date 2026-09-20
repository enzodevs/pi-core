type ConsoleMethod = (...args: unknown[]) => void;

const SUPPRESSED_PREFIXES = [
	"Failed to decrypt message with any known session",
	"Session error:",
	"Closing open session in favor of incoming prekey bundle",
	"Closing session:",
	"Session already closed",
];

function isLibsignalNoise(args: unknown[]): boolean {
	const first = args[0];
	return typeof first === "string" && SUPPRESSED_PREFIXES.some((prefix) => first.startsWith(prefix));
}

export interface ConsoleFilter {
	restore(): void;
	suppressed(): number;
}

export function suppressLibsignalConsole(target: Console = console): ConsoleFilter {
	const originals = {
		error: target.error,
		warn: target.warn,
		info: target.info,
	};
	let count = 0;
	const wrap = (original: ConsoleMethod): ConsoleMethod =>
		function filtered(...args: unknown[]) {
			if (isLibsignalNoise(args)) {
				count++;
				return;
			}
			original.apply(target, args);
		};
	const wrappers = {
		error: wrap(originals.error),
		warn: wrap(originals.warn),
		info: wrap(originals.info),
	};
	target.error = wrappers.error;
	target.warn = wrappers.warn;
	target.info = wrappers.info;
	return {
		restore() {
			if (target.error === wrappers.error) target.error = originals.error;
			if (target.warn === wrappers.warn) target.warn = originals.warn;
			if (target.info === wrappers.info) target.info = originals.info;
		},
		suppressed: () => count,
	};
}
