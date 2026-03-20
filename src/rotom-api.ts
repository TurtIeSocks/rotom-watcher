import { z } from "zod";

import type { Metrics } from "./metrics";
import type { StatusResponse } from "./types";
import { fetchWithTimeout } from "./utils";

const memoryInfoSchema = z.object({
	memFree: z.number(),
	memMitm: z.number(),
	memStart: z.number(),
});

const connectionInfoSchema = z.object({
	dateConnected: z.number(),
	dateLastMessageReceived: z.number(),
	dateLastMessageSent: z.number(),
	deviceId: z.string(),
	init: z.boolean(),
	instanceNo: z.number(),
	isAlive: z.boolean(),
	lastMemory: memoryInfoSchema,
	nextId: z.number(),
	noMessagesReceived: z.number(),
	noMessagesSent: z.number(),
	origin: z.string(),
	publicIp: z.string(),
	version: z.number(),
});

const statusResponseSchema = z.object({
	devices: z.array(connectionInfoSchema),
	workers: z.array(
		z.object({
			worker: connectionInfoSchema,
		}),
	),
});

export type RotomApiErrorCode =
	| "http_error"
	| "invalid_json"
	| "invalid_payload"
	| "network_error"
	| "timeout";

export class RotomApiError extends Error {
	constructor(
		public readonly code: RotomApiErrorCode,
		message: string,
		public readonly statusCode?: number,
	) {
		super(message);
		this.name = "RotomApiError";
	}
}

export class RotomApiClient {
	private readonly baseUrl: URL;

	constructor(
		baseUrl: string,
		private readonly timeoutMs: number,
		private readonly metrics?: Metrics,
		private readonly fetchImplementation: typeof fetch = fetch,
	) {
		this.baseUrl = new URL(baseUrl);
	}

	async deleteDevice(deviceId: string): Promise<boolean> {
		const startTime = Date.now();

		try {
			const response = await fetchWithTimeout(
				new URL(
					`/api/device/${encodeURIComponent(deviceId)}/action/delete`,
					this.baseUrl,
				).toString(),
				this.timeoutMs,
				this.fetchImplementation,
			);
			const durationMs = Date.now() - startTime;

			if (!response.ok) {
				this.metrics?.recordApiRequest(
					"delete_device",
					"failure",
					durationMs,
					"http_error",
				);
				return false;
			}

			this.metrics?.recordApiRequest("delete_device", "success", durationMs);
			return true;
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const classifiedError = classifyApiError(error);

			this.metrics?.recordApiRequest(
				"delete_device",
				"failure",
				durationMs,
				classifiedError.code,
			);
			throw classifiedError;
		}
	}

	async fetchStatus(): Promise<StatusResponse> {
		const startTime = Date.now();

		try {
			const response = await fetchWithTimeout(
				new URL("/api/status", this.baseUrl).toString(),
				this.timeoutMs,
				this.fetchImplementation,
			);

			if (!response.ok) {
				const durationMs = Date.now() - startTime;
				this.metrics?.recordApiRequest(
					"fetch_status",
					"failure",
					durationMs,
					"http_error",
				);
				throw new RotomApiError(
					"http_error",
					`Rotom API returned HTTP ${response.status}`,
					response.status,
				);
			}

			let payload: unknown;

			try {
				payload = await response.json();
			} catch (error) {
				const durationMs = Date.now() - startTime;
				this.metrics?.recordApiRequest(
					"fetch_status",
					"failure",
					durationMs,
					"invalid_json",
				);
				throw new RotomApiError(
					"invalid_json",
					error instanceof Error
						? error.message
						: "Rotom API returned invalid JSON",
				);
			}

			const parsed = statusResponseSchema.safeParse(payload);
			if (!parsed.success) {
				const durationMs = Date.now() - startTime;
				this.metrics?.recordApiRequest(
					"fetch_status",
					"failure",
					durationMs,
					"invalid_payload",
				);
				throw new RotomApiError("invalid_payload", parsed.error.message);
			}

			const durationMs = Date.now() - startTime;
			this.metrics?.recordApiRequest("fetch_status", "success", durationMs);
			return parsed.data;
		} catch (error) {
			if (error instanceof RotomApiError) {
				throw error;
			}

			const durationMs = Date.now() - startTime;
			const classifiedError = classifyApiError(error);
			this.metrics?.recordApiRequest(
				"fetch_status",
				"failure",
				durationMs,
				classifiedError.code,
			);
			throw classifiedError;
		}
	}
}

const classifyApiError = (error: unknown): RotomApiError => {
	if (error instanceof RotomApiError) {
		return error;
	}

	if (error instanceof DOMException && error.name === "AbortError") {
		return new RotomApiError("timeout", "Rotom API request timed out");
	}

	if (error instanceof Error) {
		return new RotomApiError("network_error", error.message);
	}

	return new RotomApiError("network_error", String(error));
};
