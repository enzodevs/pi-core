export function getHeadroomPaths(
	home?: string,
	platform?: NodeJS.Platform,
): {
	directory: string;
	venv: string;
	python: string;
	originals: string;
};
