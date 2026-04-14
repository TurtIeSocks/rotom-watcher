export const sanitizeOrigin = (origin: string): string =>
	origin.replace(/[^a-zA-Z0-9._-]/g, "");

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const truncateOutput = (value: string, maxLength = 4_000): string => {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
};

export const calculateRetryDelay = (
	attempt: number,
	initialRetryDelayMs: number,
	maxRetryDelayMs: number,
	jitterRatio = 0.2,
	random = Math.random,
): number => {
	const exponentialDelay = initialRetryDelayMs * 2 ** attempt;
	const cappedDelay = Math.min(exponentialDelay, maxRetryDelayMs);
	const jitterWindow = cappedDelay * jitterRatio;
	const jitter = random() * jitterWindow * 2 - jitterWindow;

	return Math.max(0, Math.round(cappedDelay + jitter));
};

export interface FetchWithTimeoutResult {
	/**
	 * Aborts the request. Safe to call after the response has been consumed;
	 * once the body is fully read this becomes a no-op.
	 */
	cancel: () => void;
	response: Response;
}

/**
 * Wraps `fetch` with a timeout covering both the request AND the response
 * body read. Callers must invoke `result.cancel()` once they are done with
 * the body (success or failure) to release the timer.
 *
 * The legacy `fetchWithTimeout(...)` call site — which only needed the
 * headers — remains supported; it clears the timer in the `finally` block.
 */
export const fetchWithTimeoutHandle = async (
	url: string,
	timeoutMs: number,
	fetchImplementation: typeof fetch = fetch,
	options: RequestInit = {},
): Promise<FetchWithTimeoutResult> => {
	const controller = new AbortController();
	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		const response = await fetchImplementation(url, {
			...options,
			signal: controller.signal,
		});
		return {
			cancel: () => {
				clearTimeout(timeoutId);
			},
			response,
		};
	} catch (error) {
		clearTimeout(timeoutId);
		if (timedOut && error instanceof Error && error.name === "AbortError") {
			throw error;
		}
		throw error;
	}
};

export const fetchWithTimeout = async (
	url: string,
	timeoutMs: number,
	fetchImplementation: typeof fetch = fetch,
	options: RequestInit = {},
): Promise<Response> => {
	const { cancel, response } = await fetchWithTimeoutHandle(
		url,
		timeoutMs,
		fetchImplementation,
		options,
	);
	cancel();
	return response;
};
