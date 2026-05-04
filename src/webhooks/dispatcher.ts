import type { LoggerLike } from "../observability/logger";
import type { EventName, WebhookEvent, WebhookTransport } from "./types";

export interface DispatcherConfig {
	coalesceWindowMs: number;
	discordUrls: string[];
	events: ReadonlySet<EventName>;
}

export interface WebhookDispatcherDeps {
	config: DispatcherConfig;
	logger: LoggerLike;
	transport: WebhookTransport;
}

export class WebhookDispatcher {
	private readonly config: DispatcherConfig;
	private readonly logger: LoggerLike;
	private readonly pending = new Set<Promise<void>>();
	private readonly transport: WebhookTransport;

	constructor(deps: WebhookDispatcherDeps) {
		this.config = deps.config;
		this.logger = deps.logger;
		this.transport = deps.transport;
	}

	emit(event: WebhookEvent): void {
		if (this.config.discordUrls.length === 0) {
			return;
		}
		if (!this.config.events.has(event.name)) {
			return;
		}

		const tracked: Promise<void> = this.dispatch([event]).finally(() => {
			this.pending.delete(tracked);
		});
		this.pending.add(tracked);
	}

	async flush(): Promise<void> {
		while (this.pending.size > 0) {
			await Promise.all([...this.pending]);
		}
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
