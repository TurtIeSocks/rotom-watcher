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

export const fetchWithTimeout = async (
	url: string,
	timeoutMs: number,
	fetchImplementation: typeof fetch = fetch,
	options: RequestInit = {},
): Promise<Response> => {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetchImplementation(url, {
			signal: controller.signal,
			...options,
		});
	} finally {
		clearTimeout(timeoutId);
	}
};
