import type { LoggerLike } from "../observability/logger";
import { formatDuration } from "../shared/utils";
import { SEVERITY, SEVERITY_COLOR, SEVERITY_LABEL } from "./events";
import type {
	EventName,
	Severity,
	WebhookEvent,
	WebhookEventOf,
	WebhookTransport,
} from "./types";

export interface DiscordTransportConfig {
	avatarUrl: string;
	discordUrls: string[];
	mentionRoleId: string;
	retryAttempts: number;
	retryInitialDelayMs: number;
	username: string;
}

export interface DiscordTransportClock {
	now(): number;
}

export interface DiscordTransportDeps {
	clock?: DiscordTransportClock;
	config: DiscordTransportConfig;
	fetchImpl?: typeof fetch;
	logger: LoggerLike;
	sleepFn?: (ms: number) => Promise<void>;
}

interface DiscordEmbed {
	color: number;
	description?: string;
	fields?: { inline?: boolean; name: string; value: string }[];
	footer?: { text: string };
	title: string;
}

interface DiscordWebhookBody {
	allowed_mentions?: { roles: string[] };
	avatar_url?: string;
	content?: string;
	embeds: DiscordEmbed[];
	username: string;
}

const defaultClock: DiscordTransportClock = { now: () => Date.now() };

const formatTimestamp = (ms: number): string => {
	const date = new Date(ms);
	const yyyy = date.getUTCFullYear();
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const min = String(date.getUTCMinutes()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
};

type Renderer<N extends EventName> = (
	event: WebhookEventOf<N>,
	timestamp: string,
) => DiscordEmbed;

const titleFor = (severity: Severity, name: EventName, subject: string) =>
	`${SEVERITY_LABEL[severity]} · ${name} | ${subject}`;

const baseEmbed = (event: WebhookEvent, timestamp: string): DiscordEmbed => {
	const severity = SEVERITY[event.name];
	return {
		color: SEVERITY_COLOR[severity],
		footer: { text: `rotom-watcher • ${timestamp}` },
		title: titleFor(severity, event.name, event.subject),
	};
};

const RENDERERS: { [N in EventName]: Renderer<N> } = {
	"circuit_breaker.closed": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: "Rotom API circuit breaker returned to **CLOSED**.",
	}),
	"circuit_breaker.half_open": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description:
			"Rotom API circuit breaker entered **HALF_OPEN** — testing recovery.",
		fields: [
			{
				inline: true,
				name: "Reset window",
				value: formatDuration(event.fields.resetMs),
			},
		],
	}),
	"circuit_breaker.opened": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description:
			"Rotom API failures hit the threshold. Circuit breaker **OPENED**.",
		fields: [
			{
				inline: true,
				name: "Failures",
				value: event.fields.failures.toString(),
			},
			{
				inline: true,
				name: "Threshold",
				value: event.fields.threshold.toString(),
			},
			{
				inline: true,
				name: "Reset",
				value: formatDuration(event.fields.resetMs),
			},
		],
	}),
	"device.duplicate_deleted": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Removed dead duplicate device on **${event.fields.origin}**.`,
		fields: [
			{
				inline: true,
				name: "Device ID",
				value: `\`${event.fields.deviceId}\``,
			},
		],
	}),
	"group.pipeline.triggered": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Group recovery pipeline triggered for **${event.subject}**.`,
		fields: [
			{
				inline: true,
				name: "Group size",
				value: event.fields.groupSize.toString(),
			},
			{ inline: true, name: "Trigger", value: event.fields.trigger },
		],
	}),
	"origin.offline.restart": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Origin **${event.subject}** appears offline. Running \`restart\` script.`,
		fields: [
			{ inline: true, name: "Mode", value: "`restart`" },
			{
				inline: true,
				name: "Attempt",
				value: event.fields.attempt.toString(),
			},
			{
				inline: true,
				name: "Devices",
				value: event.fields.devices.toString(),
			},
			{
				inline: true,
				name: "Last seen",
				value: `${formatDuration(event.fields.lastSeenMs)} ago`,
			},
		],
	}),
	"origin.offline.update": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Origin **${event.subject}** escalated to \`update\` mode after repeated restart failures.`,
		fields: [
			{ inline: true, name: "Mode", value: "`update`" },
			{
				inline: true,
				name: "Offline streak",
				value: event.fields.offlineStreak.toString(),
			},
			{
				inline: true,
				name: "Devices",
				value: event.fields.devices.toString(),
			},
			{
				inline: true,
				name: "Last seen",
				value: `${formatDuration(event.fields.lastSeenMs)} ago`,
			},
		],
	}),
	"origin.recovered": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Origin **${event.subject}** is back online.`,
		fields: [
			{
				inline: true,
				name: "Down for",
				value: formatDuration(event.fields.downForMs),
			},
			{
				inline: true,
				name: "Last script",
				value: `\`${event.fields.lastScript}\``,
			},
			{ inline: true, name: "Result", value: event.fields.result },
			{
				inline: true,
				name: "Devices",
				value: event.fields.devices.toString(),
			},
		],
	}),
	"poll.failed": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: "Rotom API poll failed.",
		fields: [
			{ name: "Reason", value: event.fields.reason },
			{
				inline: true,
				name: "Took",
				value: formatDuration(event.fields.durationMs),
			},
		],
	}),
	"queue.saturated": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: "Job queue saturated; new jobs being rejected.",
		fields: [
			{
				inline: true,
				name: "Capacity",
				value: event.fields.capacity.toString(),
			},
			{
				inline: true,
				name: "Running",
				value: event.fields.running.toString(),
			},
			{ inline: true, name: "Queued", value: event.fields.queued.toString() },
			{
				inline: true,
				name: "Rejected",
				value: event.fields.rejected.toString(),
			},
		],
	}),
	"script.failed": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Origin **${event.subject}** could not be recovered after retries.`,
		fields: [
			{ inline: true, name: "Mode", value: `\`${event.fields.mode}\`` },
			{
				inline: true,
				name: "Exit",
				value:
					event.fields.exitCode === null
						? "—"
						: event.fields.exitCode.toString(),
			},
			{
				inline: true,
				name: "Tries",
				value: event.fields.attempts.toString(),
			},
			{
				inline: true,
				name: "Took",
				value: formatDuration(event.fields.durationMs),
			},
		],
		footer: { text: `run ${event.fields.runId} • ${timestamp}` },
	}),
	"script.succeeded": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Recovery script for **${event.subject}** completed successfully.`,
		fields: [
			{ inline: true, name: "Mode", value: `\`${event.fields.mode}\`` },
			{
				inline: true,
				name: "Attempt",
				value: event.fields.attempt.toString(),
			},
			{
				inline: true,
				name: "Took",
				value: formatDuration(event.fields.durationMs),
			},
		],
		footer: { text: `run ${event.fields.runId} • ${timestamp}` },
	}),
	"script.timed_out": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `Recovery script on **${event.subject}** was killed for exceeding its timeout.`,
		fields: [
			{ inline: true, name: "Mode", value: `\`${event.fields.mode}\`` },
			{
				inline: true,
				name: "Attempt",
				value: event.fields.attempt.toString(),
			},
			{
				inline: true,
				name: "Timeout",
				value: formatDuration(event.fields.timeoutMs),
			},
		],
		footer: { text: `run ${event.fields.runId} • ${timestamp}` },
	}),
	"service.started": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `rotom-watcher v${event.fields.version} started.`,
		fields: [
			{ inline: true, name: "Origins", value: event.fields.origins.toString() },
			{
				inline: true,
				name: "Poll interval",
				value: formatDuration(event.fields.pollIntervalMs),
			},
			{
				inline: true,
				name: "Concurrency",
				value: event.fields.concurrency.toString(),
			},
			{ inline: true, name: "PID", value: event.fields.pid.toString() },
		],
	}),
	"service.stopping": (event, timestamp) => ({
		...baseEmbed(event, timestamp),
		description: `rotom-watcher shutting down (${event.fields.reason}).`,
		fields: [
			{
				inline: true,
				name: "Running jobs",
				value: event.fields.runningJobs.toString(),
			},
			{
				inline: true,
				name: "Queued jobs",
				value: event.fields.queuedJobs.toString(),
			},
		],
	}),
};

const renderEmbed = (event: WebhookEvent, timestamp: string): DiscordEmbed => {
	const renderer = RENDERERS[event.name] as Renderer<EventName>;
	return renderer(event as never, timestamp);
};

// --- Coalesced batch rendering ---

const SUBJECT_LIMIT = 20;
const MAX_RETRY_DELAY_MS = 30_000;
const FIELD_VALUE_LIMIT = 1024;

const summaryFor = (name: EventName, count: number): string => {
	switch (name) {
		case "origin.offline.restart":
			return `${count} origins entered offline state.`;
		case "origin.offline.update":
			return `${count} origins escalated to update mode.`;
		case "origin.recovered":
			return `${count} origins recovered.`;
		case "script.failed":
			return `${count} recovery scripts failed.`;
		case "script.succeeded":
			return `${count} recovery scripts succeeded.`;
		case "script.timed_out":
			return `${count} recovery scripts timed out.`;
		case "poll.failed":
			return `${count} polls failed.`;
		case "device.duplicate_deleted":
			return `${count} dead duplicates removed.`;
		case "group.pipeline.triggered":
			return `${count} group pipelines triggered.`;
		default:
			// Singleton events (circuit_breaker.*, queue.saturated, service.*) should
			// not realistically coalesce; this is a safety fallback.
			return `${count} events received.`;
	}
};

const renderCoalesced = (
	batch: WebhookEvent[],
	timestamp: string,
): DiscordEmbed => {
	// All events in a coalesced batch share the same name; guaranteed by WebhookDispatcher
	// which buckets the buffer by EventName.
	// biome-ignore lint/style/noNonNullAssertion: send guarantees length >= 1
	const name = batch[0]!.name;
	const severity = SEVERITY[name];
	const uniqueSubjects = Array.from(
		new Set(batch.map((event) => event.subject)),
	);
	const shown = uniqueSubjects.slice(0, SUBJECT_LIMIT);
	const remaining = uniqueSubjects.length - shown.length;
	let subjectsValue =
		remaining > 0
			? `${shown.join(", ")}, + ${remaining} more`
			: shown.join(", ");
	if (subjectsValue.length > FIELD_VALUE_LIMIT) {
		subjectsValue = `${subjectsValue.slice(0, FIELD_VALUE_LIMIT - 3)}...`;
	}

	return {
		color: SEVERITY_COLOR[severity],
		description: summaryFor(name, batch.length),
		fields: [{ name: "Subjects", value: subjectsValue }],
		footer: { text: `coalesced batch • ${timestamp}` },
		title: `${SEVERITY_LABEL[severity]} · ${name} (×${batch.length}) | multiple subjects`,
	};
};

export class DiscordTransport implements WebhookTransport {
	private readonly clock: DiscordTransportClock;
	private readonly config: DiscordTransportConfig;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: LoggerLike;
	private readonly sleepFn: (ms: number) => Promise<void>;

	constructor(deps: DiscordTransportDeps) {
		this.clock = deps.clock ?? defaultClock;
		this.config = deps.config;
		this.fetchImpl = deps.fetchImpl ?? fetch;
		this.logger = deps.logger;
		this.sleepFn =
			deps.sleepFn ??
			((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	async send(batch: WebhookEvent[]): Promise<void> {
		if (batch.length === 0 || this.config.discordUrls.length === 0) {
			return;
		}

		const timestamp = formatTimestamp(this.clock.now());
		const embed =
			batch.length === 1
				? // biome-ignore lint/style/noNonNullAssertion: length asserted above
					renderEmbed(batch[0]!, timestamp)
				: renderCoalesced(batch, timestamp);
		const body: DiscordWebhookBody = {
			embeds: [embed],
			username: this.config.username,
		};
		if (this.config.avatarUrl !== "") {
			body.avatar_url = this.config.avatarUrl;
		}

		await Promise.all(
			this.config.discordUrls.map((url) => this.postWithRetry(url, body)),
		);
	}

	private async postWithRetry(
		url: string,
		body: DiscordWebhookBody,
	): Promise<void> {
		let attempt = 0;
		while (true) {
			const result = await this.tryPost(url, body);
			if (result.ok) {
				return;
			}
			if (!result.retryable) {
				this.logger.warn(
					{ reason: result.reason, status: result.status, url },
					"Dropping webhook (non-retryable)",
				);
				return;
			}
			if (attempt >= this.config.retryAttempts) {
				this.logger.error(
					{ reason: result.reason, status: result.status, url },
					"Dropping webhook after exhausting retries",
				);
				return;
			}
			const delay =
				result.retryAfterMs ??
				Math.min(
					this.config.retryInitialDelayMs * 2 ** attempt,
					MAX_RETRY_DELAY_MS,
				);
			await this.sleepFn(delay);
			attempt += 1;
		}
	}

	private async tryPost(
		url: string,
		body: DiscordWebhookBody,
	): Promise<
		| { ok: true }
		| {
				ok: false;
				reason: string;
				retryable: boolean;
				retryAfterMs?: number;
				status?: number;
		  }
	> {
		try {
			const response = await this.fetchImpl(url, {
				body: JSON.stringify(body),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			if (response.ok) {
				return { ok: true };
			}
			if (response.status === 429) {
				const retryAfter = response.headers.get("retry-after");
				const parsed = retryAfter !== null ? Number(retryAfter) : Number.NaN;
				const retryAfterMs =
					Number.isFinite(parsed) && parsed >= 0
						? Math.round(parsed * 1000)
						: undefined;
				return {
					ok: false,
					reason: "429",
					retryable: true,
					retryAfterMs,
					status: 429,
				};
			}
			if (response.status >= 500) {
				return {
					ok: false,
					reason: "5xx",
					retryable: true,
					status: response.status,
				};
			}
			return {
				ok: false,
				reason: "4xx",
				retryable: false,
				status: response.status,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown";
			return { ok: false, reason: `network: ${message}`, retryable: true };
		}
	}
}
