import type { LoggerLike } from "../observability/logger";

type QueueJob = () => Promise<void>;

export interface QueueStatus {
	activeOrigins: string[];
	capacity: number;
	duplicateRejectedTotal: number;
	queued: number;
	running: number;
	saturated: boolean;
}

export interface QueueStatusObserver {
	updateQueueStatus(status: QueueStatus): void;
}

export class JobQueue {
	private concurrency: number;
	private duplicateRejectedTotal = 0;
	private readonly inProgress = new Set<string>();
	private readonly queued: QueueJob[] = [];
	private readonly running = new Set<QueueJob>();

	constructor(
		concurrency: number,
		private readonly logger: LoggerLike,
		private readonly observer?: QueueStatusObserver,
	) {
		this.concurrency = concurrency;
	}

	async add(task: () => Promise<void>, origin: string): Promise<void> {
		if (this.isInProgress(origin)) {
			this.duplicateRejectedTotal++;
			this.logger.debug({ origin }, "Skipping duplicate queued job");
			this.notifyStatusChanged();
			return;
		}

		this.inProgress.add(origin);
		this.notifyStatusChanged();

		return new Promise((resolve, reject) => {
			const job: QueueJob = async () => {
				try {
					await task();
					resolve();
				} catch (error) {
					reject(error);
				} finally {
					this.inProgress.delete(origin);
					this.running.delete(job);
					this.notifyStatusChanged();
					this.processQueue();
				}
			};

			this.queued.push(job);
			this.notifyStatusChanged();
			this.processQueue();
		});
	}

	getStatus(): QueueStatus {
		return {
			activeOrigins: [...this.inProgress].sort((left, right) =>
				left.localeCompare(right),
			),
			capacity: this.concurrency,
			duplicateRejectedTotal: this.duplicateRejectedTotal,
			queued: this.queued.length,
			running: this.running.size,
			saturated: this.running.size >= this.concurrency,
		};
	}

	isInProgress(origin: string): boolean {
		return this.inProgress.has(origin);
	}

	setConcurrency(concurrency: number): void {
		this.concurrency = concurrency;
		this.notifyStatusChanged();
		this.processQueue();
	}

	private notifyStatusChanged(): void {
		this.observer?.updateQueueStatus(this.getStatus());
	}

	private processQueue(): void {
		while (this.running.size < this.concurrency && this.queued.length > 0) {
			const job = this.queued.shift();
			if (!job) {
				return;
			}

			this.running.add(job);
			this.notifyStatusChanged();
			void job();
		}
	}
}
