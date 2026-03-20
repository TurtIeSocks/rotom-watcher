import type { LoggerLike } from "./logger";

type QueueJob = () => Promise<void>;

export interface QueueStatus {
	queued: number;
	running: number;
}

export class JobQueue {
	private readonly inProgress = new Set<string>();
	private readonly queued: QueueJob[] = [];
	private readonly running = new Set<QueueJob>();

	constructor(
		private readonly concurrency: number,
		private readonly logger: LoggerLike,
	) {}

	async add(task: () => Promise<void>, origin: string): Promise<void> {
		if (this.isInProgress(origin)) {
			this.logger.debug(`Skipping duplicate job for ${origin}`);
			return;
		}

		this.inProgress.add(origin);

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
					this.processQueue();
				}
			};

			this.queued.push(job);
			this.processQueue();
		});
	}

	getStatus(): QueueStatus {
		return {
			queued: this.queued.length,
			running: this.running.size,
		};
	}

	isInProgress(origin: string): boolean {
		return this.inProgress.has(origin);
	}

	private processQueue(): void {
		while (this.running.size < this.concurrency && this.queued.length > 0) {
			const job = this.queued.shift();
			if (!job) {
				return;
			}

			this.running.add(job);
			void job();
		}
	}
}
