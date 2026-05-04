import type { Device, Worker } from "../rotom/types";
import type {
	DeviceEvaluationResult,
	GroupDecision,
	OriginDecision,
} from "./types";

export interface EvaluateDevicesOptions {
	currentTimeMs: number;
	deviceTimeoutMinutes: number;
	devices: Device[];
	workers: Worker[];
}

const extractGroupPrefix = (origin: string): string | undefined => {
	const lastDotIndex = origin.lastIndexOf(".");
	if (lastDotIndex === -1) {
		return undefined;
	}
	const suffix = origin.slice(lastDotIndex + 1);
	if (suffix.length === 0 || !/^\d+$/.test(suffix)) {
		return undefined;
	}
	return origin.slice(0, lastDotIndex);
};

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

	const originsByPrefix = new Map<string, string[]>();
	const originHasAliveDevice = new Map<string, boolean>();

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

		originHasAliveDevice.set(origin, hasAliveDevice);

		const prefix = extractGroupPrefix(origin);
		if (prefix !== undefined) {
			const members = originsByPrefix.get(prefix) ?? [];
			members.push(origin);
			originsByPrefix.set(prefix, members);
		}
	}

	const groupDecisions: GroupDecision[] = [];
	const suppressedOrigins = new Set<string>();

	for (const [prefix, members] of originsByPrefix.entries()) {
		if (members.length < 2) {
			continue;
		}
		const everyMemberDead = members.every(
			(origin) => originHasAliveDevice.get(origin) === false,
		);
		if (!everyMemberDead) {
			continue;
		}
		const sortedMembers = [...members].sort((left, right) =>
			left.localeCompare(right),
		);
		groupDecisions.push({
			members: sortedMembers,
			prefix,
		});
		for (const member of members) {
			suppressedOrigins.add(member);
		}
	}

	if (suppressedOrigins.size > 0) {
		for (const decision of originDecisions) {
			if (suppressedOrigins.has(decision.origin)) {
				decision.shouldProcess = false;
				decision.deadDuplicatesToDelete = [];
			}
		}
	}

	originDecisions.sort((left, right) =>
		left.origin.localeCompare(right.origin),
	);
	onlineOrigins.sort((left, right) => left.localeCompare(right));
	groupDecisions.sort((left, right) => left.prefix.localeCompare(right.prefix));

	return {
		groupDecisions,
		onlineOrigins,
		originDecisions,
	};
};
