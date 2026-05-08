import {
	Counter,
	collectDefaultMetrics,
	Gauge,
	Histogram,
	Registry,
} from "prom-client";

import type { OriginStateStats, ScriptMode } from "../monitor/types";
import type { CircuitBreakerState } from "../runtime/circuit-breaker";
import type { QueueStatus, QueueStatusObserver } from "../runtime/job-queue";

export type ApiOperation = "delete_device" | "fetch_status";
export type ApiRequestResult = "failure" | "success";
export type ApiFailureReason =
	| "http_error"
	| "invalid_json"
	| "invalid_payload"
	| "network_error"
	| "timeout";
export type ScriptFailureReason =
	| "exit_code"
	| "signal"
	| "spawn_error"
	| "timeout";

export interface HealthSnapshot {
	healthy: boolean;
	lastSuccessfulPollTimestamp: number | null;
	ready: boolean;
	shutdownRequested: boolean;
}

export class Metrics implements QueueStatusObserver {
	private readonly registry = new Registry();
	private lastSuccessfulPollTimestamp: number | null = null;
	private shutdownRequested = false;

	private readonly apiRequests = new Counter({
		help: "API requests by operation and result",
		labelNames: ["operation", "result"] as const,
		name: "rotom_watcher_api_requests_total",
		registers: [this.registry],
	});

	private readonly apiFailureReasons = new Counter({
		help: "API failures by operation and reason",
		labelNames: ["operation", "reason"] as const,
		name: "rotom_watcher_api_failures_total",
		registers: [this.registry],
	});

	private readonly apiLatency = new Histogram({
		buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
		help: "API request duration in seconds",
		labelNames: ["operation", "result"] as const,
		name: "rotom_watcher_api_request_duration_seconds",
		registers: [this.registry],
	});

	private readonly circuitBreakerState = new Gauge({
		help: "Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)",
		name: "rotom_watcher_circuit_breaker_state",
		registers: [this.registry],
	});

	private readonly duplicateDeletion = new Counter({
		help: "Duplicate deletion results",
		labelNames: ["result"] as const,
		name: "rotom_watcher_duplicate_deletions_total",
		registers: [this.registry],
	});

	private readonly lastSuccessfulPoll = new Gauge({
		help: "Unix timestamp of the last successful poll",
		name: "rotom_watcher_last_successful_poll_timestamp_seconds",
		registers: [this.registry],
	});

	private readonly originOffline = new Gauge({
		help: "Tracked offline origins",
		name: "rotom_watcher_origins_offline",
		registers: [this.registry],
	});

	private readonly originTracked = new Gauge({
		help: "Total tracked origin states",
		name: "rotom_watcher_origins_tracked",
		registers: [this.registry],
	});

	private readonly pollDuration = new Histogram({
		buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
		help: "Poll duration in seconds",
		name: "rotom_watcher_poll_duration_seconds",
		registers: [this.registry],
	});

	private readonly queueCapacity = new Gauge({
		help: "Queue concurrency capacity",
		name: "rotom_watcher_queue_capacity",
		registers: [this.registry],
	});

	private readonly queueDuplicateRejectedTotal = new Gauge({
		help: "Total duplicate jobs rejected by the queue",
		name: "rotom_watcher_queue_duplicate_rejected_total",
		registers: [this.registry],
	});

	private readonly queueQueued = new Gauge({
		help: "Currently queued jobs",
		name: "rotom_watcher_queue_jobs_queued",
		registers: [this.registry],
	});

	private readonly queueRunning = new Gauge({
		help: "Currently running jobs",
		name: "rotom_watcher_queue_jobs_running",
		registers: [this.registry],
	});

	private readonly queueSaturated = new Gauge({
		help: "Whether the queue is saturated (0/1)",
		name: "rotom_watcher_queue_saturated",
		registers: [this.registry],
	});

	private readonly scriptAttempts = new Counter({
		help: "Script execution attempts by mode",
		labelNames: ["mode"] as const,
		name: "rotom_watcher_script_attempts_total",
		registers: [this.registry],
	});

	private readonly scriptRetries = new Counter({
		help: "Script retries by mode",
		labelNames: ["mode"] as const,
		name: "rotom_watcher_script_retries_total",
		registers: [this.registry],
	});

	private readonly scriptFailures = new Counter({
		help: "Script failures by mode and reason",
		labelNames: ["mode", "reason"] as const,
		name: "rotom_watcher_script_failures_total",
		registers: [this.registry],
	});

	private readonly scriptSuccesses = new Counter({
		help: "Successful script executions by mode",
		labelNames: ["mode"] as const,
		name: "rotom_watcher_script_successes_total",
		registers: [this.registry],
	});

	private readonly scriptDuration = new Histogram({
		buckets: [0.1, 0.5, 1, 2, 5, 15, 30, 60, 120, 300],
		help: "Script execution duration in seconds",
		labelNames: ["mode", "result"] as const,
		name: "rotom_watcher_script_duration_seconds",
		registers: [this.registry],
	});

	private readonly groupPipelineTriggered = new Counter({
		help: "Group recovery pipelines triggered per poll (counts intent to enqueue; in-flight prefixes get deduped at the queue but still increment), labeled by prefix",
		labelNames: ["prefix"] as const,
		name: "rotom_watcher_groups_pipeline_triggered_total",
		registers: [this.registry],
	});

	private readonly webhookCoalesced = new Counter({
		help: "Webhook events merged into a coalesced batch (events past the first per batch)",
		labelNames: ["event"] as const,
		name: "rotom_watcher_webhook_events_coalesced_total",
		registers: [this.registry],
	});

	private readonly webhookDelivered = new Counter({
		help: "Webhook batches successfully delivered, by event name and severity",
		labelNames: ["event", "severity"] as const,
		name: "rotom_watcher_webhook_events_delivered_total",
		registers: [this.registry],
	});

	private readonly webhookFailed = new Counter({
		help: "Webhook delivery failures, by event name and reason",
		labelNames: ["event", "reason"] as const,
		name: "rotom_watcher_webhook_events_failed_total",
		registers: [this.registry],
	});

	constructor() {
		collectDefaultMetrics({
			prefix: "rotom_watcher_process_",
			register: this.registry,
		});
	}

	getContentType(): string {
		return this.registry.contentType;
	}

	getHealthSnapshot(): HealthSnapshot {
		return {
			healthy: !this.shutdownRequested,
			lastSuccessfulPollTimestamp: this.lastSuccessfulPollTimestamp,
			ready:
				!this.shutdownRequested && this.lastSuccessfulPollTimestamp !== null,
			shutdownRequested: this.shutdownRequested,
		};
	}

	async render(): Promise<string> {
		return this.registry.metrics();
	}

	markShutdownRequested(): void {
		this.shutdownRequested = true;
	}

	recordApiRequest(
		operation: ApiOperation,
		result: ApiRequestResult,
		durationMs: number,
		reason?: ApiFailureReason,
	): void {
		this.apiRequests.inc({
			operation,
			result,
		});
		this.apiLatency.observe(
			{
				operation,
				result,
			},
			durationMs / 1000,
		);

		if (reason) {
			this.apiFailureReasons.inc({
				operation,
				reason,
			});
		}
	}

	recordDuplicateDeletion(result: ApiRequestResult): void {
		this.duplicateDeletion.inc({
			result,
		});
	}

	recordPollDuration(durationMs: number): void {
		this.pollDuration.observe(durationMs / 1000);
	}

	recordPollSuccess(timestampMs: number): void {
		this.lastSuccessfulPollTimestamp = timestampMs;
		this.lastSuccessfulPoll.set(timestampMs / 1000);
	}

	recordScriptAttempt(mode: ScriptMode): void {
		this.scriptAttempts.inc({
			mode,
		});
	}

	recordScriptFailure(
		mode: ScriptMode,
		durationMs: number,
		reason: ScriptFailureReason,
	): void {
		this.scriptFailures.inc({
			mode,
			reason,
		});
		this.scriptDuration.observe(
			{
				mode,
				result: "failure",
			},
			durationMs / 1000,
		);
	}

	recordScriptRetry(mode: ScriptMode): void {
		this.scriptRetries.inc({
			mode,
		});
	}

	recordScriptSuccess(mode: ScriptMode, durationMs: number): void {
		this.scriptSuccesses.inc({
			mode,
		});
		this.scriptDuration.observe(
			{
				mode,
				result: "success",
			},
			durationMs / 1000,
		);
	}

	recordGroupPipelineTriggered(prefix: string): void {
		this.groupPipelineTriggered.inc({
			prefix,
		});
	}

	recordWebhookCoalesced(event: string, count: number): void {
		this.webhookCoalesced.inc({ event }, count);
	}

	recordWebhookDelivered(event: string, severity: string): void {
		this.webhookDelivered.inc({ event, severity });
	}

	recordWebhookFailed(event: string, reason: string): void {
		this.webhookFailed.inc({ event, reason });
	}

	setCircuitBreakerState(state: CircuitBreakerState): void {
		const numericState = state === "OPEN" ? 2 : state === "HALF_OPEN" ? 1 : 0;
		this.circuitBreakerState.set(numericState);
	}

	updateOriginState(stats: OriginStateStats): void {
		this.originTracked.set(stats.totalTracked);

		const totalOffline = Object.values(stats.byCount).reduce(
			(total, count) => total + count,
			0,
		);
		this.originOffline.set(totalOffline);
	}

	updateQueueStatus(status: QueueStatus): void {
		this.queueCapacity.set(status.capacity);
		this.queueDuplicateRejectedTotal.set(status.duplicateRejectedTotal);
		this.queueQueued.set(status.queued);
		this.queueRunning.set(status.running);
		this.queueSaturated.set(status.saturated ? 1 : 0);
	}
}
