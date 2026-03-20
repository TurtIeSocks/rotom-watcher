import type { Device, Worker } from "../rotom/types";
import type { DeviceEvaluationResult, OriginDecision } from "./types";

export interface EvaluateDevicesOptions {
	currentTimeMs: number;
	deviceTimeoutMinutes: number;
	devices: Device[];
	workers: Worker[];
}

export const evaluateDevices = ({
	currentTimeMs,
	deviceTimeoutMinutes,
	devices,
	workers,
}: EvaluateDevicesOptions): DeviceEvaluationResult => {
	const devicesByOrigin = devices.reduce<Map<string, Device[]>>(
		(accumulator, device) => {
			const originDevices = accumulator.get(device.origin) ?? [];
			originDevices.push(device);
			accumulator.set(device.origin, originDevices);
			return accumulator;
		},
		new Map(),
	);
	const workerOrigins = new Set(workers.map((worker) => worker.worker.origin));

	const onlineOrigins: string[] = [];
	const originDecisions: OriginDecision[] = [];

	for (const [origin, originDevices] of devicesByOrigin.entries()) {
		const hasWorkers = workerOrigins.has(origin);
		const hasAliveDevice = originDevices.some((device) => device.isAlive);
		const latestMessageReceived = originDevices.reduce(
			(latest, device) => Math.max(latest, device.dateLastMessageReceived),
			Number.NEGATIVE_INFINITY,
		);
		const lastSeenMinutes =
			(currentTimeMs - latestMessageReceived) / (1000 * 60);
		const originIsOnline = hasWorkers && hasAliveDevice;
		const deadDuplicatesToDelete = originIsOnline
			? originDevices
					.filter((device) => !device.isAlive)
					.map((device) => ({
						deviceId: device.deviceId,
						origin,
					}))
			: [];
		const shouldProcess =
			!originIsOnline &&
			(!hasWorkers || lastSeenMinutes > deviceTimeoutMinutes);

		if (originIsOnline) {
			onlineOrigins.push(origin);
		}

		originDecisions.push({
			deadDuplicatesToDelete,
			hasAliveDevice,
			hasWorkers,
			lastSeenMinutes,
			origin,
			shouldProcess,
		});
	}

	originDecisions.sort((left, right) =>
		left.origin.localeCompare(right.origin),
	);
	onlineOrigins.sort((left, right) => left.localeCompare(right));

	return {
		onlineOrigins,
		originDecisions,
	};
};
