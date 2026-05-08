import type { ScriptMode } from "../monitor/types";

export type Severity = "critical" | "warning" | "success" | "info";

export type EventName =
	| "circuit_breaker.closed"
	| "circuit_breaker.half_open"
	| "circuit_breaker.opened"
	| "device.duplicate_deleted"
	| "group.pipeline.triggered"
	| "origin.offline.restart"
	| "origin.offline.update"
	| "origin.recovered"
	| "poll.failed"
	| "queue.saturated"
	| "script.failed"
	| "script.succeeded"
	| "script.timed_out"
	| "service.started"
	| "service.stopping";

export type WebhookEvent =
	| {
			fields: {
				attempt: number;
				devices: number;
				lastSeenMs: number;
				mode: "restart";
			};
			name: "origin.offline.restart";
			subject: string;
	  }
	| {
			fields: {
				devices: number;
				lastSeenMs: number;
				mode: "update";
				offlineStreak: number;
			};
			name: "origin.offline.update";
			subject: string;
	  }
	| {
			fields: {
				devices: number;
				downForMs: number;
				lastScript: ScriptMode;
				result: "success" | "unknown";
			};
			name: "origin.recovered";
			subject: string;
	  }
	| {
			fields: {
				attempt: number;
				durationMs: number;
				mode: ScriptMode;
				runId: string;
			};
			name: "script.succeeded";
			subject: string;
	  }
	| {
			fields: {
				attempts: number;
				durationMs: number;
				exitCode: number | null;
				mode: ScriptMode;
				runId: string;
			};
			name: "script.failed";
			subject: string;
	  }
	| {
			fields: {
				attempt: number;
				mode: ScriptMode;
				runId: string;
				timeoutMs: number;
			};
			name: "script.timed_out";
			subject: string;
	  }
	| {
			fields: {
				failures: number;
				resetMs: number;
				threshold: number;
			};
			name: "circuit_breaker.opened";
			subject: "rotom-api";
	  }
	| {
			fields: { resetMs: number };
			name: "circuit_breaker.half_open";
			subject: "rotom-api";
	  }
	| {
			fields: Record<string, never>;
			name: "circuit_breaker.closed";
			subject: "rotom-api";
	  }
	| {
			fields: {
				capacity: number;
				queued: number;
				rejected: number;
				running: number;
			};
			name: "queue.saturated";
			subject: "job-queue";
	  }
	| {
			fields: { durationMs: number; reason: string };
			name: "poll.failed";
			subject: "rotom-api";
	  }
	| {
			fields: { deviceId: string; origin: string };
			name: "device.duplicate_deleted";
			subject: string;
	  }
	| {
			fields: { groupSize: number; trigger: string };
			name: "group.pipeline.triggered";
			subject: string;
	  }
	| {
			fields: {
				concurrency: number;
				origins: number;
				pid: number;
				pollIntervalMs: number;
				version: string;
			};
			name: "service.started";
			subject: "rotom-watcher";
	  }
	| {
			fields: { queuedJobs: number; reason: string; runningJobs: number };
			name: "service.stopping";
			subject: "rotom-watcher";
	  };

export type WebhookEventOf<N extends EventName> = Extract<
	WebhookEvent,
	{ name: N }
>;

export interface WebhookTransport {
	send(batch: WebhookEvent[]): Promise<void>;
}

export interface WebhookEmitter {
	emit(event: WebhookEvent): void;
}
