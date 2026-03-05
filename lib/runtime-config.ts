const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");
const RUNTIME_BACKEND_STORAGE_KEY = "collbrush_backend_url";

const tryParseHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
};

const coerceHttpBaseUrl = (value: string) => {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("wss://")) {
    return `https://${trimmed.slice("wss://".length)}`;
  }

  if (trimmed.startsWith("ws://")) {
    return `http://${trimmed.slice("ws://".length)}`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("//")) {
    if (typeof window !== "undefined") {
      return `${window.location.protocol}${trimmed}`;
    }
    return `https:${trimmed}`;
  }

  return `https://${trimmed}`;
};

export const getPublicBackendBaseUrl = () => {
  const raw = process.env.NEXT_PUBLIC_BACKEND_URL?.trim();
  if (!raw) {
    return "";
  }

  return normalizeBaseUrl(coerceHttpBaseUrl(raw));
};

const getRuntimeOverrideBackendBaseUrl = () => {
  if (typeof window === "undefined") {
    return "";
  }

  const readStored = () => {
    try {
      const stored = window.localStorage.getItem(RUNTIME_BACKEND_STORAGE_KEY)?.trim() ?? "";
      if (!stored) {
        return "";
      }
      const parsed = tryParseHttpUrl(coerceHttpBaseUrl(stored));
      return parsed ? normalizeBaseUrl(parsed) : "";
    } catch {
      return "";
    }
  };

  try {
    const url = new URL(window.location.href);
    const queryValue = url.searchParams.get("backend")?.trim() ?? "";
    if (queryValue) {
      const parsed = tryParseHttpUrl(coerceHttpBaseUrl(queryValue));
      if (parsed) {
        const normalized = normalizeBaseUrl(parsed);
        window.localStorage.setItem(RUNTIME_BACKEND_STORAGE_KEY, normalized);
        return normalized;
      }
    }
  } catch {
    return readStored();
  }

  return readStored();
};

export const getResolvedBackendBaseUrl = () => {
  const runtimeOverride = getRuntimeOverrideBackendBaseUrl();
  if (runtimeOverride) {
    return runtimeOverride;
  }

  return getPublicBackendBaseUrl();
};

export const buildBackendUrl = (pathWithQuery: string) => {
  const baseUrl = getResolvedBackendBaseUrl();
  if (!baseUrl) {
    return pathWithQuery;
  }

  return `${baseUrl}${pathWithQuery}`;
};

export const getSocketServerUrl = () => {
  const baseUrl = getResolvedBackendBaseUrl();
  return baseUrl || undefined;
};
