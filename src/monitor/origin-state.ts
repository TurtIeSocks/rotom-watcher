import type { LoggerLike } from "../observability/logger";
import type {
	OfflineAttemptResult,
	OriginState,
	OriginStateStats,
	ScriptMode,
} from "./types";

export interface OriginStateTrackerOptions {
	/**
	 * If set, entries whose `lastSeen` is older than this many milliseconds
	 * relative to the sweep timestamp are considered abandoned (origin was
	 * removed upstream, renamed, or has permanently died) and are dropped.
	 * Prevents unbounded map growth over long runtimes.
	 */
	maxEntryAgeMs?: number;
}

export class OriginStateTracker {
	private readonly maxEntryAgeMs: number;
	private restartThreshold: number;
	private readonly states = new Map<string, OriginState>();

	constructor(
		restartThreshold: number,
		private readonly logger?: LoggerLike,
		options: OriginStateTrackerOptions = {},
	) {
		this.restartThreshold = restartThreshold;
		this.maxEntryAgeMs = options.maxEntryAgeMs ?? 0;
	}

	/**
	 * Remove entries that haven't been touched in `maxEntryAgeMs`. Called
	 * from the device monitor each poll. No-op when TTL is disabled.
	 */
	sweepStale(nowMs: number): number {
		if (this.maxEntryAgeMs <= 0) {
			return 0;
		}
		const cutoff = nowMs - this.maxEntryAgeMs;
		let removed = 0;
		for (const [origin, state] of this.states) {
			if (state.lastSeen < cutoff) {
				this.states.delete(origin);
				removed++;
			}
		}
		if (removed > 0) {
			this.logger?.info(
				{ removed },
				"Swept stale origin state entries (TTL)",
			);
		}
		return removed;
	}

	clearOriginState(origin: string): void {
		if (this.states.has(origin)) {
			this.logger?.debug({ origin }, "Clearing origin state after recovery");
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
			this.logger?.info({ removed }, "Cleared recovered origin state");
		}
	}

	getScriptMode(origin: string): ScriptMode {
		const state = this.states.get(origin);
		if (!state) {
			return "restart";
		}

		if (state.successiveOfflineCount >= this.restartThreshold) {
			return "update";
		}

		return "restart";
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

	setRestartThreshold(restartThreshold: number): void {
		this.restartThreshold = restartThreshold;
	}

	recordOfflineAttempt(
		origin: string,
		timestamp = Date.now(),
	): OfflineAttemptResult {
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

		const scriptMode = this.getScriptMode(origin);
		this.logger?.debug(
			{
				origin,
				scriptMode,
				successiveOfflineCount: state.successiveOfflineCount,
			},
			"Recorded offline attempt",
		);

		return {
			origin,
			scriptMode,
			state: {
				...state,
			},
		};
	}
}
