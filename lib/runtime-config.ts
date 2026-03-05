const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");

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

export const buildBackendUrl = (pathWithQuery: string) => {
  const baseUrl = getPublicBackendBaseUrl();
  if (!baseUrl) {
    return pathWithQuery;
  }

  return `${baseUrl}${pathWithQuery}`;
};

export const getSocketServerUrl = () => {
  const baseUrl = getPublicBackendBaseUrl();
  return baseUrl || undefined;
};
