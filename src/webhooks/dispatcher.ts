import type { LoggerLike } from "../observability/logger";
import type { EventName, WebhookEvent, WebhookTransport } from "./types";

export interface DispatcherMetrics {
	recordWebhookCoalesced(event: string, count: number): void;
}

export interface DispatcherConfig {
	coalesceWindowMs: number;
	discordUrls: string[];
	events: ReadonlySet<EventName>;
}

export interface DispatcherClock {
	clearTimer(id: ReturnType<typeof setTimeout>): void;
	now(): number;
	setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
}

const defaultClock: DispatcherClock = {
	clearTimer: (id) => clearTimeout(id),
	now: () => Date.now(),
	setTimer: (fn, ms) => setTimeout(fn, ms),
};

export interface WebhookDispatcherDeps {
	clock?: DispatcherClock;
	config: DispatcherConfig;
	logger: LoggerLike;
	metrics?: DispatcherMetrics;
	transport: WebhookTransport;
}

interface BufferedBatch {
	events: WebhookEvent[];
	timer: ReturnType<typeof setTimeout>;
}

export class WebhookDispatcher {
	private readonly buffer = new Map<EventName, BufferedBatch>();
	private readonly clock: DispatcherClock;
	private readonly config: DispatcherConfig;
	private readonly logger: LoggerLike;
	private readonly metrics: DispatcherMetrics;
	private readonly pending = new Set<Promise<void>>();
	private readonly transport: WebhookTransport;

	constructor(deps: WebhookDispatcherDeps) {
		this.clock = deps.clock ?? defaultClock;
		this.config = deps.config;
		this.logger = deps.logger;
		this.metrics = deps.metrics ?? {
			recordWebhookCoalesced: () => undefined,
		};
		this.transport = deps.transport;
	}

	emit(event: WebhookEvent): void {
		if (this.config.discordUrls.length === 0) {
			return;
		}
		if (!this.config.events.has(event.name)) {
			return;
		}

		if (this.config.coalesceWindowMs <= 0) {
			this.trackDispatch([event]);
			return;
		}

		const existing = this.buffer.get(event.name);
		if (existing) {
			existing.events.push(event);
			return;
		}

		const timer = this.clock.setTimer(() => {
			const batch = this.buffer.get(event.name);
			if (!batch) {
				return;
			}
			this.buffer.delete(event.name);
			this.trackDispatch(batch.events);
		}, this.config.coalesceWindowMs);

		this.buffer.set(event.name, { events: [event], timer });
	}

	async flush(): Promise<void> {
		for (const [name, batch] of this.buffer) {
			this.clock.clearTimer(batch.timer);
			this.buffer.delete(name);
			this.trackDispatch(batch.events);
		}
		while (this.pending.size > 0) {
			await Promise.all([...this.pending]);
		}
	}

	private trackDispatch(batch: WebhookEvent[]): void {
		if (batch.length > 1) {
			// biome-ignore lint/style/noNonNullAssertion: length > 1 guarantees [0]
			this.metrics.recordWebhookCoalesced(batch[0]!.name, batch.length - 1);
		}
		const tracked: Promise<void> = this.dispatch(batch).finally(() => {
			this.pending.delete(tracked);
		});
		this.pending.add(tracked);
	}

	private async dispatch(batch: WebhookEvent[]): Promise<void> {
		try {
			await this.transport.send(batch);
		} catch (error) {
			this.logger.error(
				{
					error,
					eventCount: batch.length,
					eventNames: batch.map((event) => event.name),
				},
				"Webhook transport send failed",
			);
		}
	}
}
