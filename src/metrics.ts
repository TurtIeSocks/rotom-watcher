export interface MetricsStats {
	apiCallsFailed: number;
	apiCallsSucceeded: number;
	avgExecutionTimeMs: number | string;
	scriptsExecuted: number;
	scriptsFailed: number;
	scriptsSucceeded: number;
	successRate: string;
}

export class Metrics {
	private apiCallsFailed = 0;
	private apiCallsSucceeded = 0;
	private scriptsExecuted = 0;
	private scriptsFailed = 0;
	private scriptsSucceeded = 0;
	private totalExecutionTime = 0;

	recordApiFailure(): void {
		this.apiCallsFailed++;
	}

	recordApiSuccess(): void {
		this.apiCallsSucceeded++;
	}

	recordScriptFailure(durationMs: number): void {
		this.scriptsExecuted++;
		this.scriptsFailed++;
		this.totalExecutionTime += durationMs;
	}

	recordScriptSuccess(durationMs: number): void {
		this.scriptsExecuted++;
		this.scriptsSucceeded++;
		this.totalExecutionTime += durationMs;
	}

	getStats(): MetricsStats {
		const avgExecutionTime =
			this.scriptsExecuted > 0
				? (this.totalExecutionTime / this.scriptsExecuted).toFixed(2)
				: 0;

		return {
			apiCallsFailed: this.apiCallsFailed,
			apiCallsSucceeded: this.apiCallsSucceeded,
			avgExecutionTimeMs: avgExecutionTime,
			scriptsExecuted: this.scriptsExecuted,
			scriptsFailed: this.scriptsFailed,
			scriptsSucceeded: this.scriptsSucceeded,
			successRate:
				this.scriptsExecuted > 0
					? `${((this.scriptsSucceeded / this.scriptsExecuted) * 100).toFixed(2)}%`
					: "N/A",
		};
	}
}
