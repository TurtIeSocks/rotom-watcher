import type { LoggerLike } from "./logger";
import type { OriginState, OriginStateStats } from "./types";

export class OriginStateTracker {
	private readonly states = new Map<string, OriginState>();

	constructor(
		private readonly restartThreshold: number,
		private readonly restartArg = "-rsc",
		private readonly updateArg = "-usc",
		private readonly logger?: LoggerLike,
	) {}

	clearOriginState(origin: string): void {
		if (this.states.has(origin)) {
			this.logger?.debug(`[${origin}] Clearing state (now online)`);
			this.states.delete(origin);
		}
	}

	cleanupOnlineOrigins(onlineOrigins: string[]): void {
		const beforeSize = this.states.size;

		for (const origin of onlineOrigins) {
			this.clearOriginState(origin);
		}

		const removed = beforeSize - this.states.size;
		if (removed > 0) {
			this.logger?.info(
				`Cleaned up ${removed} origin(s) that came back online`,
			);
		}
	}

	getScriptArgs(origin: string): string {
		const state = this.states.get(origin);
		if (!state) {
			return this.restartArg;
		}

		if (state.successiveOfflineCount >= this.restartThreshold) {
			return this.updateArg;
		}

		return this.restartArg;
	}

	getState(origin: string): OriginState | undefined {
		return this.states.get(origin);
	}

	getStats(): OriginStateStats {
		const byCount: Record<string, number> = {};

		for (const state of this.states.values()) {
			const key = state.successiveOfflineCount.toString();
			byCount[key] = (byCount[key] ?? 0) + 1;
		}

		return {
			byCount,
			totalTracked: this.states.size,
		};
	}

	recordOfflineAttempt(origin: string, timestamp = Date.now()): OriginState {
		const existing = this.states.get(origin);

		if (existing) {
			existing.lastSeen = timestamp;
			existing.successiveOfflineCount++;
		} else {
			this.states.set(origin, {
				lastSeen: timestamp,
				successiveOfflineCount: 1,
			});
		}

		const state = this.states.get(origin);
		if (!state) {
			throw new Error(`Expected origin state to exist for ${origin}`);
		}

		this.logger?.debug(
			`[${origin}] Recorded offline attempt #${state.successiveOfflineCount}`,
		);

		return state;
	}
}
