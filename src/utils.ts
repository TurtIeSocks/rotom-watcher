export const sanitizeOrigin = (origin: string): string =>
	origin.replace(/[^a-zA-Z0-9._-]/g, "");

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const calculateRetryDelay = (
	attempt: number,
	initialRetryDelayMs: number,
	maxRetryDelayMs: number,
): number => {
	const delay = initialRetryDelayMs * 2 ** attempt;
	return Math.min(delay, maxRetryDelayMs);
};

export const fetchWithTimeout = async (
	url: string,
	timeoutMs: number,
	fetchImplementation: typeof fetch = fetch,
): Promise<Response> => {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetchImplementation(url, {
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeoutId);
	}
};
