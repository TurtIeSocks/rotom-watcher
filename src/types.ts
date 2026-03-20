export interface MemoryInfo {
	memFree: number;
	memMitm: number;
	memStart: number;
}

export interface ConnectionInfo {
	dateConnected: number;
	dateLastMessageReceived: number;
	dateLastMessageSent: number;
	deviceId: string;
	init: boolean;
	instanceNo: number;
	isAlive: boolean;
	lastMemory: MemoryInfo;
	nextId: number;
	noMessagesReceived: number;
	noMessagesSent: number;
	origin: string;
	publicIp: string;
	version: number;
}

export interface StatusWorker {
	worker: ConnectionInfo;
}

export interface StatusResponse {
	devices: ConnectionInfo[];
	workers: StatusWorker[];
}

export interface OriginState {
	lastSeen: number;
	successiveOfflineCount: number;
}

export interface OriginStateStats {
	byCount: Record<string, number>;
	totalTracked: number;
}

export interface DeviceToProcess {
	origin: string;
	timeDifference: string;
}

export interface DeviceEvaluationResult {
	devicesToProcess: DeviceToProcess[];
	onlineOrigins: string[];
}
