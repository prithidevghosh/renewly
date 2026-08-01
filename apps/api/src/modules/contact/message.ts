/**
 * The "someone used the contact form" mail, sent to CONTACT_NOTIFY_TO.
 *
 * Read by us rather than by a customer, so it follows the waitlist notice: the
 * facts in a fixed order, the sender in the subject so the inbox is searchable,
 * and the message itself last, kept verbatim. Line breaks are preserved because
 * a paragraph the sender typed as three lines is not the same message reflowed
 * into one.
 */

const INK = "#1B1815";
const INK_2 = "#544E45";
const INK_3 = "#8B8478";
const IVORY = "#F4F0E8";
const PAPER = "#FBF9F4";
const RULE = "#E2DCD0";

const SERIF = "Newsreader, Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export interface ContactMessageInput {
  name: string;
  email: string;
  message: string;
  receivedAt: Date;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderContactMessage(input: ContactMessageInput): RenderedEmail {
  const fields: Array<[string, string]> = [
    ["Name", input.name],
    ["Email", input.email],
    ["Received", input.receivedAt.toISOString()],
  ];

  return {
    subject: `Contact · ${input.name} · ${input.email}`,
    html: html(fields, input.message),
    text: text(fields, input.message),
  };
}

function html(fields: Array<[string, string]>, message: string): string {
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
    <title>New contact message</title>
  </head>
  <body style="margin:0;padding:0;background:${IVORY};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${IVORY};">
      <tr>
        <td align="center" style="padding:32px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
            <tr>
              <td style="background:${PAPER};border:1px solid ${RULE};border-radius:2px;padding:28px 28px 24px;">
                <p style="margin:0 0 6px;font-family:${SANS};font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${INK_3};">New contact message</p>
                <p style="margin:0 0 20px;font-family:${SERIF};font-size:28px;line-height:1.1;color:${INK};">${escapeHtml(fields[0]?.[1] ?? "")}</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
                </table>
                <p style="margin:24px 0 8px;font-family:${SANS};font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${INK_3};">Message</p>
                <div style="font-family:${SANS};font-size:15px;line-height:1.6;color:${INK};white-space:pre-wrap;word-break:break-word;">${escapeHtml(message)}</div>
                <p style="margin:24px 0 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${INK_2};">Reply to this mail to answer them directly.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function text(fields: Array<[string, string]>, message: string): string {
  const width = Math.max(...fields.map(([label]) => label.length));
  return [
    "NEW CONTACT MESSAGE",
    "",
    ...fields.map(([label, value]) => `${label.padEnd(width)}  ${value}`),
    "",
    "MESSAGE",
    "",
    message,
    "",
    "Reply to this mail to answer them directly.",
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
