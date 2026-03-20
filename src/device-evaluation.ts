import type {
	ConnectionInfo,
	DeviceEvaluationResult,
	StatusWorker,
} from "./types";

export interface EvaluateDevicesOptions {
	currentTimeMs: number;
	deviceTimeoutMinutes: number;
	devices: ConnectionInfo[];
	workers: StatusWorker[];
}

export const evaluateDevices = ({
	currentTimeMs,
	deviceTimeoutMinutes,
	devices,
	workers,
}: EvaluateDevicesOptions): DeviceEvaluationResult => {
	const deviceAliveMap = devices.reduce<Record<string, boolean>>(
		(acc, device) => {
			if (!(device.origin in acc)) {
				acc[device.origin] = device.isAlive;
			}

			return acc;
		},
		{},
	);

	const onlineOrigins: string[] = [];
	const devicesToProcess: DeviceEvaluationResult["devicesToProcess"] = [];

	for (const device of devices) {
		const hasWorkers = workers.some(
			(worker) => worker.worker.origin === device.origin,
		);

		if (!deviceAliveMap[device.origin] || !hasWorkers) {
			const timeDifferenceMinutes =
				(currentTimeMs - device.dateLastMessageReceived) / (1000 * 60);

			if (timeDifferenceMinutes > deviceTimeoutMinutes || !hasWorkers) {
				devicesToProcess.push({
					origin: device.origin,
					timeDifference: timeDifferenceMinutes.toFixed(2),
				});
			}
		} else {
			onlineOrigins.push(device.origin);
		}
	}

	return {
		devicesToProcess,
		onlineOrigins,
	};
};
