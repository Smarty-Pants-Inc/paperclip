export function readLimitFromEnv(name: string, stockDefault: number): number {
  const raw = process.env[name]?.trim() ?? "";
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : stockDefault;
}
