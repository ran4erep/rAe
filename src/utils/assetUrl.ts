/**
 * Normalizes a Vite base path so root ("/"), subpath ("/repo/"),
 * and relative ("./") deployments resolve static assets consistently.
 */
export function normalizeBasePath(raw?: string): string {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed || trimmed === '/') {
    return '/';
  }
  if (trimmed === '.' || trimmed === './') {
    return './';
  }
  const withTrailing = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  if (
    withTrailing.startsWith('./') ||
    withTrailing.startsWith('http://') ||
    withTrailing.startsWith('https://')
  ) {
    return withTrailing;
  }
  return withTrailing.startsWith('/') ? withTrailing : `/${withTrailing}`;
}

export function joinBaseUrl(baseUrl: string, relativePath: string): string {
  const cleanRel = relativePath.replace(/^\/+/, '');
  const normalizedBase = normalizeBasePath(baseUrl);
  return `${normalizedBase}${cleanRel}`;
}

// Precomputed once at module load (zero per-frame / runtime allocation).
const RUNTIME_BASE_URL: string = normalizeBasePath(
  typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.BASE_URL : '/'
);

export function getAppAssetUrl(relativePath: string): string {
  return joinBaseUrl(RUNTIME_BASE_URL, relativePath);
}
