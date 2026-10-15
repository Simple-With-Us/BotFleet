export declare const FAILED_INSTALL_KEEP: number;

export declare function failedInstallBundles(names: string[], bundleName: string): string[];

export declare function failedInstallStamp(name: string, bundleName: string): number | null;

export declare function failedInstallBundlesToPrune(
  names: string[],
  bundleName: string,
  keep?: number,
): string[];

export declare function pruneFailedInstallBundles(
  appPath: string,
  options?: {
    keep?: number;
    listNames: (directory: string) => string[];
    remove: (path: string) => void;
  },
): string[];
