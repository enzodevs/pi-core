export function getPythonPaths(
	home?: string,
	platform?: NodeJS.Platform,
): {
	directory: string;
	venv: string;
	python: string;
};
