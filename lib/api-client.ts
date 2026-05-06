export function apiUrl(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}
