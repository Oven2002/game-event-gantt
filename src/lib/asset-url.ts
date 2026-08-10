export function resolveAssetUrl(baseUrl: string, assetPath: string, origin: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`${normalizedBase}${assetPath.replace(/^\/+/, "")}`, origin).href;
}
