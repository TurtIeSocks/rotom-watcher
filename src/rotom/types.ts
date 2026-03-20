export interface StatusResponse {
	devices: Device[];
	workers: Worker[];
}

export interface Device extends BaseStatus {
	lastMemory: LastMemory;
	nextId: number;
	dateConnected: number;
	publicIp: string;
	version: number;
}

export interface LastMemory {
	memFree: number;
	memMitm: number;
	memStart: number;
}

export interface Worker {
	deviceId: string;
	controller?: Controller;
	isAllocated: boolean;
	worker: WorkerStatus;
	workerId: string;
}

export interface Controller {
	dateLastMessageSent: number;
	instanceNo: number;
	heartbeatCheckStatus: boolean;
	isAlive: boolean;
	loginListener: number;
	origin: string;
	workerId: string;
	workerName: string;
}

export interface BaseStatus {
	deviceId: string;
	dateLastMessageReceived: number;
	dateLastMessageSent: number;
	init: boolean;
	instanceNo: number;
	heartbeatCheckStatus: boolean;
	isAlive: boolean;
	noMessagesReceived: number;
	noMessagesSent: number;
	origin: string;
}

export interface WorkerStatus extends BaseStatus {
	traceMessages: boolean;
	workerId: string;
	userAgent: string;
	version: string;
}
