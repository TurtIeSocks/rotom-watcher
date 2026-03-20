import { z } from "zod";

import type { ConfigProvider } from "./config";
import type { Metrics } from "./metrics";
import type { StatusResponse } from "./types";
import { fetchWithTimeout } from "./utils";

const lastMemorySchema = z.object({
	memFree: z.number(),
	memMitm: z.number(),
	memStart: z.number(),
});

const baseStatusSchema = z.object({
	dateLastMessageReceived: z.number(),
	dateLastMessageSent: z.number(),
	heartbeatCheckStatus: z.boolean(),
	init: z.boolean(),
	instanceNo: z.number(),
	isAlive: z.boolean(),
	noMessagesReceived: z.number(),
	noMessagesSent: z.number(),
	origin: z.string(),
});

const deviceSchema = baseStatusSchema.extend({
	dateConnected: z.number(),
	deviceId: z.string(),
	lastMemory: lastMemorySchema,
	nextId: z.number(),
	publicIp: z.string(),
	version: z.number(),
});

const controllerSchema = z.object({
	dateLastMessageSent: z.number(),
	heartbeatCheckStatus: z.boolean(),
	instanceNo: z.number(),
	isAlive: z.boolean(),
	loginListener: z.number(),
	origin: z.string(),
	workerId: z.string(),
	workerName: z.string(),
});

const workerStatusSchema = baseStatusSchema.extend({
	deviceId: z.string(),
	traceMessages: z.boolean(),
	userAgent: z.string(),
	workerId: z.string(),
	version: z.string(),
});

const workerSchema = z.object({
	controller: controllerSchema.optional(),
	deviceId: z.string(),
	isAllocated: z.boolean(),
	worker: workerStatusSchema,
	workerId: z.string(),
});

const statusResponseSchema = z.object({
	devices: z.array(deviceSchema),
	workers: z.array(workerSchema),
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
	constructor(
		private readonly configProvider: ConfigProvider,
		private readonly metrics?: Metrics,
		private readonly fetchImplementation: typeof fetch = fetch,
	) {}

	async deleteDevice(deviceId: string): Promise<boolean> {
		const startTime = Date.now();
		const config = this.configProvider.getConfig();

		try {
			const response = await fetchWithTimeout(
				new URL(
					`/api/device/${encodeURIComponent(deviceId)}/action/delete`,
					config.rotomApiBaseUrl,
				).toString(),
				config.fetchTimeoutMs,
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
		const config = this.configProvider.getConfig();

		try {
			const response = await fetchWithTimeout(
				new URL("/api/status", config.rotomApiBaseUrl).toString(),
				config.fetchTimeoutMs,
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
