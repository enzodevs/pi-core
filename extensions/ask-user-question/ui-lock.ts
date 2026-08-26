const SHARED_UI_LOCK_KEY = "__piSharedUiLock";

interface SharedUiLock {
	withLock<T>(operation: () => T | Promise<T>): Promise<T>;
}

/**
 * Pi can host only one replacement UI at a time. Keep this global key compatible
 * with other popup extensions so separately loaded modules serialize together.
 */
function getSharedUiLock(): SharedUiLock {
	const globals = globalThis as typeof globalThis & Record<string, unknown>;
	const existing = globals[SHARED_UI_LOCK_KEY];
	if (existing && typeof (existing as Partial<SharedUiLock>).withLock === "function") {
		return existing as SharedUiLock;
	}

	let tail = Promise.resolve();
	const lock: SharedUiLock = {
		withLock<T>(operation: () => T | Promise<T>): Promise<T> {
			const previous = tail;
			let release = () => {};
			tail = new Promise<void>((resolve) => {
				release = resolve;
			});
			return previous.then(operation).finally(release);
		},
	};
	globals[SHARED_UI_LOCK_KEY] = lock;
	return lock;
}

export function withSharedUiLock<T>(operation: () => T | Promise<T>): Promise<T> {
	return getSharedUiLock().withLock(operation);
}
