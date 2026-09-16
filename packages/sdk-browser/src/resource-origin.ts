function httpUrl(value: unknown, base?: URL): URL | null {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = base === undefined ? new URL(value) : new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch { return null; }
}

/** The browser page is the origin authority, including when ingestion uses a backend relay. */
export function evaluateResourceOrigin(source: string | null, page: unknown): {
  url?: { host?: string; path: string };
  first_party?: boolean;
} {
  const pageUrl = httpUrl(page);
  const url = httpUrl(source, pageUrl ?? undefined);
  if (url !== null && url.pathname.length <= 1024 && url.hostname.length <= 255) {
    return {
      url: { host: url.hostname.toLowerCase(), path: url.pathname || "/" },
      ...(pageUrl === null ? {} : { first_party: url.origin === pageUrl.origin })
    };
  }
  if (source?.startsWith("/") && !source.startsWith("//") && !source.includes("\\") && !/[\u0000-\u0020\u007f]/.test(source)) {
    const path = source.split(/[?#]/, 1)[0]!;
    if (path.length <= 1024) return { url: { path }, first_party: true };
  }
  return {};
}
