import type { LoggerLike } from "../observability/logger";

export type CircuitBreakerState = "CLOSED" | "HALF_OPEN" | "OPEN";

export class CircuitBreaker {
	private failures = 0;
	private nextAttempt: number;
	private resetTimeMs: number;
	private state: CircuitBreakerState = "CLOSED";
	private threshold: number;

	constructor(
		threshold: number,
		resetTimeMs: number,
		private readonly logger: LoggerLike,
		private readonly now: () => number = Date.now,
	) {
		this.threshold = threshold;
		this.resetTimeMs = resetTimeMs;
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

	getFailureCount(): number {
		return this.failures;
	}

	getState(): CircuitBreakerState {
		return this.state;
	}

	updateConfig(threshold: number, resetTimeMs: number): void {
		this.threshold = threshold;
		this.resetTimeMs = resetTimeMs;
	}

	recordFailure(): void {
		this.failures++;

		if (this.failures >= this.threshold) {
			this.state = "OPEN";
			this.nextAttempt = this.now() + this.resetTimeMs;
			this.logger.warn(
				{
					failures: this.failures,
					nextAttempt: this.nextAttempt,
					resetTimeMs: this.resetTimeMs,
				},
				"Circuit breaker opened",
			);
		}
	}

	recordSuccess(): void {
		const recoveredFrom = this.state;
		this.failures = 0;
		this.state = "CLOSED";

		if (recoveredFrom !== "CLOSED") {
			this.logger.info("Circuit breaker returned to CLOSED state");
		}
	}
}
