export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function percentSaved(before: number, after: number): string {
  if (before <= 0) return '0%';
  // Round down, so a large but incomplete saving never shows as 100%.
  return `${Math.floor((1 - after / before) * 100)}%`;
}

export function describeSettings(s: { ppi: number; jpegQuality: number; pngQuality: number }): string {
  const png = s.pngQuality > 0 ? `PNG 减色 ${s.pngQuality}` : 'PNG 无损';
  return `${s.ppi} PPI · JPEG ${s.jpegQuality} · ${png}`;
}
