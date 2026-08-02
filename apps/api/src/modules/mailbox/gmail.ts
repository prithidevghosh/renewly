import { env } from "../../env.js";
import { AppError } from "../../lib/errors.js";
import {
  MAILBOX_SCOPES,
  type MailMessage,
  type MailboxClient,
  type MailboxGrant,
  type MailboxTokens,
  type SearchInput,
} from "./types.js";

/**
 * Gmail read access.
 *
 * https://developers.google.com/gmail/api/reference/rest/v1/users.messages
 *
 * Note this needs the authorization-code flow with a **client secret** — the
 * One Tap sign-in path cannot grant it, because an ID token is a proof of
 * identity and carries no API authority. A workspace can therefore be signed in
 * with Google and still have no mailbox connected.
 */

interface GmailTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GmailListResponse {
  messages?: Array<{ id?: string }>;
  nextPageToken?: string;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessageResponse {
  id?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: Array<{ name?: string; value?: string }> };
}

export class GmailClient implements MailboxClient {
  readonly provider = "gmail" as const;
  readonly mode = "live" as const;

  private readonly clientId = env.GOOGLE_CLIENT_ID ?? "";
  private readonly clientSecret = env.GOOGLE_CLIENT_SECRET ?? "";

  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", MAILBOX_SCOPES.gmail.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // Both are required to receive a refresh token; without them the connection
    // silently stops working an hour later.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  async exchange(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<MailboxGrant> {
    const token = await this.postForm({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    });

    if (!token.access_token) {
      throw new AppError("UNAUTHORIZED", "Google issued no access token for the mailbox", {
        providerError: token.error ?? null,
      });
    }

    const profile = await this.getJson<{ emailAddress?: string }>(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      token.access_token,
    );
    if (!profile.emailAddress) {
      throw new AppError("UNAUTHORIZED", "Gmail returned no address for the granted mailbox");
    }

    return {
      emailAddress: profile.emailAddress,
      tokens: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        expiresIn: token.expires_in ?? null,
        scopes: token.scope ? token.scope.split(" ").filter(Boolean) : MAILBOX_SCOPES.gmail,
      },
    };
  }

  async refresh(refreshToken: string): Promise<MailboxTokens> {
    const token = await this.postForm({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    if (!token.access_token) {
      throw new AppError("UNAUTHORIZED", "Google refused to refresh the mailbox token", {
        providerError: token.error ?? null,
      });
    }

    return {
      accessToken: token.access_token,
      // A refresh response usually omits the refresh token; the caller keeps
      // the one it already has.
      refreshToken: token.refresh_token ?? null,
      expiresIn: token.expires_in ?? null,
      scopes: token.scope ? token.scope.split(" ").filter(Boolean) : MAILBOX_SCOPES.gmail,
    };
  }

  async search(input: SearchInput): Promise<MailMessage[]> {
    // Gmail's own query language does the narrowing server-side, which matters:
    // pulling a whole mailbox to filter locally would be slow and rude.
    const terms = input.keywords.map((word) => `"${word}"`).join(" OR ");
    const after = Math.floor(input.since.getTime() / 1000);
    const query = `(${terms}) after:${after}`;

    const list = await this.getJson<GmailListResponse>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${input.limit}`,
      input.accessToken,
    );

    const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    const messages: MailMessage[] = [];

    for (const id of ids) {
      const detail = await this.getJson<GmailMessageResponse>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        input.accessToken,
      );
      messages.push(toMailMessage(detail));
    }

    return messages;
  }

  private async postForm(fields: Record<string, string>): Promise<GmailTokenResponse> {
    let response: Response;
    try {
      response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
    } catch (error) {
      throw new AppError("CHANNEL_SEND_FAILED", "Could not reach Google", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const payload = (await response.json().catch(() => ({}))) as GmailTokenResponse;
    if (!response.ok) {
      throw new AppError(
        "UNAUTHORIZED",
        payload.error_description ?? payload.error ?? `Google returned ${response.status}`,
        { status: response.status },
      );
    }
    return payload;
  }

  private async getJson<T>(url: string, accessToken: string): Promise<T> {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!response.ok) {
      throw new AppError("UNAUTHORIZED", `Gmail returned ${response.status}`, {
        status: response.status,
      });
    }
    return (await response.json()) as T;
  }
}

/** Gmail nests bodies in a MIME tree; the plain-text leaf is what we want. */
export function extractPlainText(part: GmailPart | undefined): string {
  if (!part) return "";

  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  for (const child of part.parts ?? []) {
    const found = extractPlainText(child);
    if (found) return found;
  }

  // No plain part at all: fall back to HTML with the tags stripped, because a
  // receipt that only exists as HTML is still a receipt.
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return "";
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function toMailMessage(detail: GmailMessageResponse): MailMessage {
  const headers = detail.payload?.headers ?? [];
  const header = (name: string): string | null =>
    headers.find((h) => h.name?.toLowerCase() === name)?.value ?? null;

  return {
    providerMessageId: detail.id ?? "",
    subject: header("subject"),
    from: header("from"),
    receivedAt: detail.internalDate ? new Date(Number(detail.internalDate)) : null,
    snippet: detail.snippet ?? null,
    body: extractPlainText(detail.payload),
  };
}
