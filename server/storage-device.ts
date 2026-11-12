// Reuse the standalone bootstrap implementation installed outside the checkout.
export { checkStorageDevice, storageDeviceGuard, STORAGE_OFFLINE_EXIT_CODE } from "../deploy/linux-server/check-storage.mjs";
export type { DeviceStat } from "../deploy/linux-server/check-storage.mjs";
