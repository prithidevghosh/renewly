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
 * Outlook mail through Microsoft Graph.
 *
 * https://learn.microsoft.com/graph/api/user-list-messages
 *
 * Graph will not combine `$search` with `$filter` on messages, so the date
 * window is applied here rather than in the query. That is why `$top` is asked
 * for generously and then trimmed: the alternative is a filter that cannot
 * express "contains the word receipt" at all.
 */

interface GraphTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GraphMessage {
  id?: string;
  subject?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  body?: { contentType?: string; content?: string };
}

interface GraphListResponse {
  value?: GraphMessage[];
}

export class OutlookClient implements MailboxClient {
  readonly provider = "outlook" as const;
  readonly mode = "live" as const;

  private readonly clientId = env.MICROSOFT_CLIENT_ID ?? "";
  private readonly clientSecret = env.MICROSOFT_CLIENT_SECRET ?? "";
  private readonly base = `https://login.microsoftonline.com/${env.MICROSOFT_TENANT}/oauth2/v2.0`;

  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(`${this.base}/authorize`);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", MAILBOX_SCOPES.outlook.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
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
      throw new AppError("UNAUTHORIZED", "Microsoft issued no access token for the mailbox", {
        providerError: token.error ?? null,
      });
    }

    const me = await this.getJson<{ mail?: string; userPrincipalName?: string }>(
      "https://graph.microsoft.com/v1.0/me",
      token.access_token,
    );
    // Personal accounts often have no `mail`; the principal name is the address.
    const emailAddress = me.mail ?? me.userPrincipalName;
    if (!emailAddress) {
      throw new AppError("UNAUTHORIZED", "Graph returned no address for the granted mailbox");
    }

    return {
      emailAddress,
      tokens: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        expiresIn: token.expires_in ?? null,
        scopes: token.scope ? token.scope.split(" ").filter(Boolean) : MAILBOX_SCOPES.outlook,
      },
    };
  }

  async refresh(refreshToken: string): Promise<MailboxTokens> {
    const token = await this.postForm({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: MAILBOX_SCOPES.outlook.join(" "),
    });

    if (!token.access_token) {
      throw new AppError("UNAUTHORIZED", "Microsoft refused to refresh the mailbox token", {
        providerError: token.error ?? null,
      });
    }

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresIn: token.expires_in ?? null,
      scopes: token.scope ? token.scope.split(" ").filter(Boolean) : MAILBOX_SCOPES.outlook,
    };
  }

  async search(input: SearchInput): Promise<MailMessage[]> {
    const search = input.keywords.join(" OR ");
    const url =
      `https://graph.microsoft.com/v1.0/me/messages` +
      `?$search=${encodeURIComponent(`"${search}"`)}` +
      `&$top=${Math.min(input.limit * 2, 100)}` +
      `&$select=id,subject,receivedDateTime,bodyPreview,from,body`;

    const list = await this.getJson<GraphListResponse>(url, input.accessToken, {
      // Required for $search on messages.
      ConsistencyLevel: "eventual",
    });

    return (list.value ?? [])
      .map(toMailMessage)
      .filter((message) => !message.receivedAt || message.receivedAt >= input.since)
      .slice(0, input.limit);
  }

  private async postForm(fields: Record<string, string>): Promise<GraphTokenResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
    } catch (error) {
      throw new AppError("CHANNEL_SEND_FAILED", "Could not reach Microsoft", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const payload = (await response.json().catch(() => ({}))) as GraphTokenResponse;
    if (!response.ok) {
      throw new AppError(
        "UNAUTHORIZED",
        payload.error_description ?? payload.error ?? `Microsoft returned ${response.status}`,
        { status: response.status },
      );
    }
    return payload;
  }

  private async getJson<T>(
    url: string,
    accessToken: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...extraHeaders,
      },
    });
    if (!response.ok) {
      throw new AppError("UNAUTHORIZED", `Graph returned ${response.status}`, {
        status: response.status,
      });
    }
    return (await response.json()) as T;
  }
}

function toMailMessage(message: GraphMessage): MailMessage {
  const content = message.body?.content ?? "";
  const body =
    message.body?.contentType?.toLowerCase() === "html"
      ? content
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/\s+/g, " ")
          .trim()
      : content;

  return {
    providerMessageId: message.id ?? "",
    subject: message.subject ?? null,
    from: message.from?.emailAddress?.address ?? null,
    receivedAt: message.receivedDateTime ? new Date(message.receivedDateTime) : null,
    snippet: message.bodyPreview ?? null,
    body,
  };
}
