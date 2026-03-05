const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");

export const getPublicBackendBaseUrl = () => {
  const raw = process.env.NEXT_PUBLIC_BACKEND_URL?.trim();
  if (!raw) {
    return "";
  }

  return normalizeBaseUrl(raw);
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
