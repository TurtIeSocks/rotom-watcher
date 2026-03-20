export interface OriginState {
	lastSeen: number;
	successiveOfflineCount: number;
}

export interface OriginStateStats {
	byCount: Record<string, number>;
	totalTracked: number;
}

export interface DeviceToDelete {
	deviceId: string;
	origin: string;
}

export interface OriginDecision {
	deadDuplicatesToDelete: DeviceToDelete[];
	hasAliveDevice: boolean;
	hasWorkers: boolean;
	lastSeenMinutes: number;
	origin: string;
	shouldProcess: boolean;
}

export interface DeviceEvaluationResult {
	onlineOrigins: string[];
	originDecisions: OriginDecision[];
}

export type ScriptMode = "restart" | "update";

export interface OfflineAttemptResult {
	origin: string;
	scriptMode: ScriptMode;
	state: OriginState;
}
