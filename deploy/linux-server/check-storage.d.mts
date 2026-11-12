import type { StorageState } from "../../shared/placement.ts";
export const STORAGE_OFFLINE_EXIT_CODE: 78;
export type DeviceStat = (path: string) => { dev: number | bigint };
export function checkStorageDevice(dataDir: string, stat?: DeviceStat, expectedDevice?: string): StorageState;
export function storageDeviceGuard(dataDir: string, stat?: DeviceStat): { initial: StorageState; sample: () => StorageState };
