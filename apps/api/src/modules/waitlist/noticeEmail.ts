/**
 * The internal "someone joined" notice, sent to WAITLIST_NOTIFY_TO.
 *
 * This one is read by us, not by a customer, so it is a record rather than a
 * piece of writing: the facts in a fixed order, scannable in a notification
 * preview, with the address in the subject so the inbox is searchable.
 */

const INK = "#1B1815";
const INK_2 = "#544E45";
const INK_3 = "#8B8478";
const IVORY = "#F4F0E8";
const PAPER = "#FBF9F4";
const RULE = "#E2DCD0";

const SERIF = "Newsreader, Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export interface WaitlistNoticeInput {
  email: string;
  name?: string | null;
  source: string;
  referrer?: string | null;
  position: number;
  joinedAt: Date;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderWaitlistNotice(input: WaitlistNoticeInput): RenderedEmail {
  const place = input.position.toLocaleString("en-US");
  const fields: Array<[string, string]> = [
    ["Email", input.email],
    ["Name", input.name?.trim() || "—"],
    ["Position", `No. ${place}`],
    ["Source", input.source],
    ["Referrer", input.referrer?.trim() || "—"],
    ["Joined", input.joinedAt.toISOString()],
  ];

  return {
    subject: `Waitlist · No. ${place} · ${input.email}`,
    html: html(fields, place),
    text: text(fields, place),
  };
}

function html(fields: Array<[string, string]>, place: string): string {
  const rows = fields
    .map(
      ([label, value]) => `
              <tr>
                <td style="padding:8px 16px 8px 0;vertical-align:top;white-space:nowrap;font-family:${SANS};font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${INK_3};border-bottom:1px solid ${RULE};">${escapeHtml(label)}</td>
                <td style="padding:8px 0;font-family:${SANS};font-size:15px;line-height:1.5;color:${INK};word-break:break-word;border-bottom:1px solid ${RULE};">${escapeHtml(value)}</td>
              </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>New waitlist signup</title>
  </head>
  <body style="margin:0;padding:0;background:${IVORY};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${IVORY};">
      <tr>
        <td align="center" style="padding:32px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
            <tr>
              <td style="background:${PAPER};border:1px solid ${RULE};border-radius:2px;padding:28px 28px 24px;">
                <p style="margin:0 0 6px;font-family:${SANS};font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${INK_3};">New waitlist signup</p>
                <p style="margin:0 0 20px;font-family:${SERIF};font-size:28px;line-height:1;color:${INK};">No.&nbsp;${escapeHtml(place)}</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
                </table>
                <p style="margin:20px 0 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${INK_2};">The welcome note was delivered before this was sent.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function text(fields: Array<[string, string]>, place: string): string {
  const width = Math.max(...fields.map(([label]) => label.length));
  return [
    `NEW WAITLIST SIGNUP — No. ${place}`,
    "",
    ...fields.map(([label, value]) => `${label.padEnd(width)}  ${value}`),
    "",
    "The welcome note was delivered before this was sent.",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
