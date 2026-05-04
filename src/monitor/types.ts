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

export interface GroupDecision {
	members: string[];
	prefix: string;
}

export interface DeviceEvaluationResult {
	groupDecisions: GroupDecision[];
	onlineOrigins: string[];
	originDecisions: OriginDecision[];
}

export type ScriptMode = "restart" | "update" | "new" | "update_all";

export interface OfflineAttemptResult {
	origin: string;
	scriptMode: ScriptMode;
	state: OriginState;
}
