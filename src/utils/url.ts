/** Joins a base URL and a relative path without losing the base path segment. */
export function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');
  return suffix === '' ? base : `${base}/${suffix}`;
}
