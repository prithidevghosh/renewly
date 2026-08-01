import type { Hono } from "hono";
import { createApp } from "../app.js";
import { createDatabase, setDatabaseHandle, type DatabaseHandle } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { setLlmClient } from "../lib/llm.js";
import { resetChannelAdapters } from "../modules/channels/registry.js";
import { seedMerchants } from "../modules/merchants/service.js";
import { setCheckoutAdapter } from "../modules/payments/checkoutAdapter.js";
import { setPravaClient } from "../modules/payments/factory.js";
import { MockPravaClient } from "../modules/payments/pravaMock.js";
import { drainOutbox, expireApprovals, runTick } from "../modules/workers/runner.js";
import type { AppEnv } from "../types/context.js";

export interface TestHarness {
  app: Hono<AppEnv>;
  handle: DatabaseHandle;
  prava: MockPravaClient;
  /** Delivers everything sitting in the outbox, as the worker would. */
  flushOutbox: () => Promise<{ sent: number; failed: number }>;
  /** Runs the expiry sweep. */
  expireApprovals: () => Promise<number>;
  tick: () => Promise<unknown>;
  close: () => Promise<void>;
}

/**
 * Boots an isolated in-process Postgres, applies the real migrations and wires
 * a fresh mock rail. Every test file gets its own database, so tests run in
 * parallel without sharing state.
 *
 * The worker loop is not started: tests drive it explicitly via `flushOutbox`
 * so message delivery is deterministic rather than time-dependent.
 */
export async function createHarness(
  options: { prava?: MockPravaClient } = {},
): Promise<TestHarness> {
  const handle = createDatabase("pglite://memory");
  setDatabaseHandle(handle);
  await runMigrations(handle);
  await seedMerchants(handle.db);

  const prava = options.prava ?? new MockPravaClient();
  setPravaClient(prava);
  setCheckoutAdapter(null);
  setLlmClient(null);
  resetChannelAdapters();

  const app = createApp();

  return {
    app,
    handle,
    prava,
    flushOutbox: () => drainOutbox(handle.db),
    expireApprovals: () => expireApprovals(handle.db),
    tick: () => runTick(handle.db),
    close: async () => {
      setPravaClient(null);
      setCheckoutAdapter(null);
      setLlmClient(null);
      resetChannelAdapters();
      setDatabaseHandle(null);
      await handle.close();
    },
  };
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export class ApiClient {
  private token: string | null = null;

  constructor(private readonly app: Hono<AppEnv>) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      token?: string | null;
      form?: FormData;
      rawBody?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const token = options.token !== undefined ? options.token : this.token;
    if (token) headers.authorization = `Bearer ${token}`;

    let body: string | FormData | undefined;
    if (options.form) {
      body = options.form;
    } else if (options.rawBody !== undefined) {
      headers["content-type"] ??= "application/json";
      body = options.rawBody;
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await this.app.request(`http://localhost${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  get<T = Record<string, unknown>>(path: string, token?: string | null) {
    return this.request<T>("GET", path, token !== undefined ? { token } : {});
  }
  post<T = Record<string, unknown>>(path: string, body?: unknown, token?: string | null) {
    return this.request<T>("POST", path, {
      ...(body !== undefined ? { body } : {}),
      ...(token !== undefined ? { token } : {}),
    });
  }
  patch<T = Record<string, unknown>>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body !== undefined ? { body } : {});
  }
  delete<T = Record<string, unknown>>(path: string) {
    return this.request<T>("DELETE", path);
  }
  upload<T = Record<string, unknown>>(path: string, form: FormData) {
    return this.request<T>("POST", path, { form });
  }
  /** Webhooks are unauthenticated and signature-verified, so they post raw. */
  webhook<T = Record<string, unknown>>(
    path: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ) {
    return this.request<T>("POST", path, {
      rawBody: typeof payload === "string" ? payload : JSON.stringify(payload),
      token: null,
      headers,
    });
  }
}

export function textFile(name: string, content: string, type = "text/plain"): File {
  return new File([content], name, { type });
}

export interface ErrorBodyShape {
  error: { code: string; message: string; details: Record<string, unknown> };
}

export function expectErrorCode(body: unknown): string {
  const shaped = body as ErrorBodyShape;
  return shaped?.error?.code ?? "NO_ERROR_BODY";
}
