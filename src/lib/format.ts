const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Human-readable byte size (binary, 1024-based): formatBytes(1536) === "1.5 KB". */
export function formatBytes(bytes: number | bigint): string {
  let value = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (!Number.isFinite(value) || value < 0) return "—";
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${unitIndex === 0 ? value : value.toFixed(1)} ${UNITS[unitIndex]}`;
}
