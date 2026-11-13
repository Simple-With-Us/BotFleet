export function planCredentialRestore(values: unknown, config: object): {
  env: Record<string, string>;
  restored: string[];
  retained: string[];
};
export function markExternalInstanceCredentials(config: object, instanceIds: string[]): {
  config: object;
  changed: boolean;
};
