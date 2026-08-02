import type { ApiErrorBody } from "./types";

export const API_ORIGIN = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(
  /\/$/,
  "",
);

export class RenewlyApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.name = "RenewlyApiError";
    this.code = body?.error?.code ?? "UNKNOWN_ERROR";
    this.status = status;
    this.details = body?.error?.details;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
  } catch {
    throw new RenewlyApiError(0, {
      error: {
        code: "API_UNREACHABLE",
        message: "Renewly cannot reach its control plane. Check that the API is running.",
      },
    });
  }

  const body = (await response.json().catch(() => null)) as T | ApiErrorBody | null;
  if (!response.ok) throw new RenewlyApiError(response.status, body as ApiErrorBody | null);
  return body as T;
}

export function oauthUrl(provider: "google" | "microsoft", redirectTo = "/onboarding") {
  return `${API_ORIGIN}/v1/auth/oauth/${provider}/start?redirectTo=${encodeURIComponent(redirectTo)}`;
}

export function mailboxConnectUrl(provider: "gmail" | "outlook", redirectTo = "/onboarding") {
  return `${API_ORIGIN}/v1/mailbox/connect/${provider}?redirectTo=${encodeURIComponent(redirectTo)}`;
}
