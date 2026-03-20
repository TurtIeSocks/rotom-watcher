import type { LoggerLike } from "./logger";

type CircuitBreakerState = "CLOSED" | "HALF_OPEN" | "OPEN";

export class CircuitBreaker {
	private failures = 0;
	private nextAttempt: number;
	private state: CircuitBreakerState = "CLOSED";

	constructor(
		private readonly threshold: number,
		private readonly resetTimeMs: number,
		private readonly logger: LoggerLike,
		private readonly now: () => number = Date.now,
	) {
		this.nextAttempt = this.now();
	}

	canExecute(): boolean {
		if (this.state === "CLOSED") {
			return true;
		}

		if (this.state === "OPEN" && this.now() >= this.nextAttempt) {
			this.state = "HALF_OPEN";
			this.logger.info("Circuit breaker entering HALF_OPEN state");
			return true;
		}

		return false;
	}

	recordFailure(): void {
		this.failures++;

		if (this.failures >= this.threshold) {
			this.state = "OPEN";
			this.nextAttempt = this.now() + this.resetTimeMs;
			this.logger.warn(
				`Circuit breaker opened after ${this.failures} failures. Will retry after ${this.resetTimeMs}ms`,
			);
		}
	}

	recordSuccess(): void {
		this.failures = 0;
		this.state = "CLOSED";
	}
}
