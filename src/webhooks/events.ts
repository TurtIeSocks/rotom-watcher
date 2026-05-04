import type { EventName, Severity } from "./types";

export const EVENT_NAMES = [
	"circuit_breaker.closed",
	"circuit_breaker.half_open",
	"circuit_breaker.opened",
	"device.duplicate_deleted",
	"group.pipeline.triggered",
	"origin.offline.restart",
	"origin.offline.update",
	"origin.recovered",
	"poll.failed",
	"queue.saturated",
	"script.failed",
	"script.succeeded",
	"script.timed_out",
	"service.started",
	"service.stopping",
] as const satisfies readonly EventName[];

export const SEVERITY = {
	"circuit_breaker.closed": "success",
	"circuit_breaker.half_open": "warning",
	"circuit_breaker.opened": "critical",
	"device.duplicate_deleted": "info",
	"group.pipeline.triggered": "info",
	"origin.offline.restart": "warning",
	"origin.offline.update": "critical",
	"origin.recovered": "success",
	"poll.failed": "warning",
	"queue.saturated": "critical",
	"script.failed": "critical",
	"script.succeeded": "success",
	"script.timed_out": "warning",
	"service.started": "info",
	"service.stopping": "info",
} as const satisfies Record<EventName, Severity>;

export const SEVERITY_COLOR: Record<Severity, number> = {
	critical: 0xed4245,
	info: 0x5865f2,
	success: 0x57f287,
	warning: 0xfaa61a,
};

export const SEVERITY_LABEL: Record<Severity, string> = {
	critical: "🔥 CRITICAL",
	info: "ℹ️ INFO",
	success: "✅ SUCCESS",
	warning: "⚠️ WARNING",
};
