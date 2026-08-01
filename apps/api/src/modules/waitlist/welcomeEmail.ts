import { env } from "../../env.js";

/**
 * The waitlist welcome mail.
 *
 * Written to the landing page's design direction — warm paper, serif headline,
 * exact figures, no decoration that does not carry meaning. Built as tables
 * with inline styles because that is the only layout every mail client agrees
 * on, and with a plain-text twin because a fair number of people will never see
 * the HTML at all.
 *
 * Palette is lifted from apps/web/src/app/site.css so the first thing someone
 * receives looks like the page they just left.
 */

const INK = "#1B1815";
const INK_2 = "#544E45";
const INK_3 = "#8B8478";
const IVORY = "#F4F0E8";
const PAPER = "#FBF9F4";
const SAGE = "#66795C";
const RULE = "#E2DCD0";

const SERIF = "Newsreader, Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export interface WaitlistWelcomeInput {
  email: string;
  name?: string | null;
  /** 1-based place in line, shown to the reader as written. */
  position: number;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const STEPS: Array<{ no: string; body: string }> = [
  {
    no: "01",
    body: "Access opens in small batches, so every early workspace gets watched closely.",
  },
  {
    no: "02",
    body: "You will get one message when your seat is ready — a link, not a queue.",
  },
  {
    no: "03",
    body: "Nothing spends and nothing acts on your behalf until you set the authority yourself.",
  },
];

export function renderWaitlistWelcome(input: WaitlistWelcomeInput): RenderedEmail {
  const first = firstName(input.name);
  const greeting = first ? `Thank you for putting your name down, ${first}.` : "Thank you for putting your name down.";
  const place = input.position.toLocaleString("en-US");
  const host = siteHost();

  const preheader = `No. ${place} in line — we will write the moment your seat opens.`;
  const lede =
    "Renewly is the agentic control plane for recurring spend. It perceives every commitment, " +
    "decides the right move, acts within the authority you set, and proves the outcome.";

  return {
    subject: "You are on the Renewly waitlist",
    html: html(input, { greeting, place, host, preheader, lede }),
    text: text(input, { greeting, place, host, lede }),
  };
}

interface Copy {
  greeting: string;
  place: string;
  host: string;
  lede: string;
}

function html(input: WaitlistWelcomeInput, copy: Copy & { preheader: string }): string {
  const steps = STEPS.map(
    (step) => `
              <tr>
                <td style="padding:0 0 14px;vertical-align:top;width:38px;font-family:${SERIF};font-size:13px;letter-spacing:.08em;color:${SAGE};">${step.no}</td>
                <td style="padding:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.55;color:${INK_2};">${escapeHtml(step.body)}</td>
              </tr>`,
  ).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>You are on the Renewly waitlist</title>
  </head>
  <body style="margin:0;padding:0;background:${IVORY};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(copy.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${IVORY};">
      <tr>
        <td align="center" style="padding:40px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
            <tr>
              <td style="padding:0 0 24px;font-family:${SERIF};font-size:22px;letter-spacing:-.02em;color:${INK};">Renewly</td>
            </tr>
            <tr>
              <td style="background:${PAPER};border:1px solid ${RULE};border-radius:2px;padding:40px 36px;">
                <p style="margin:0 0 20px;font-family:${SANS};font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${INK_3};">You are on the list</p>
                <h1 style="margin:0 0 20px;font-family:${SERIF};font-size:34px;line-height:1.15;font-weight:400;letter-spacing:-.02em;color:${INK};">Recurring spend,<br />on purpose.</h1>
                <p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.6;color:${INK_2};">${escapeHtml(copy.greeting)}</p>
                <p style="margin:0 0 28px;font-family:${SANS};font-size:16px;line-height:1.6;color:${INK_2};">${escapeHtml(copy.lede)}</p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${RULE};border-bottom:1px solid ${RULE};margin:0 0 28px;">
                  <tr>
                    <td style="padding:20px 0;">
                      <p style="margin:0 0 6px;font-family:${SANS};font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:${INK_3};">Your place in line</p>
                      <p style="margin:0;font-family:${SERIF};font-size:32px;line-height:1;color:${INK};">No.&nbsp;${escapeHtml(copy.place)}</p>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 16px;font-family:${SANS};font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${INK_3};">What happens next</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${steps}
                </table>

                <p style="margin:18px 0 0;font-family:${SANS};font-size:16px;line-height:1.6;color:${INK_2};">Reply to this message if you want to tell us what you are paying for that you would rather not be. We read every one.</p>
                <p style="margin:20px 0 0;font-family:${SERIF};font-size:16px;color:${INK};">— The Renewly team</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 4px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${INK_3};">
                <p style="margin:0 0 6px;">Sent to ${escapeHtml(input.email)} because it was entered on ${escapeHtml(copy.host)}. If that was not you, ignore this message — nothing further will be sent.</p>
                <p style="margin:0;">Renewly · ${escapeHtml(copy.host)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function text(input: WaitlistWelcomeInput, copy: Copy): string {
  const steps = STEPS.map((step) => `  ${step.no}  ${step.body}`).join("\n");

  return [
    "RENEWLY — you are on the list",
    "",
    copy.greeting,
    "",
    copy.lede,
    "",
    `Your place in line: No. ${copy.place}`,
    "",
    "What happens next",
    steps,
    "",
    "Reply to this message if you want to tell us what you are paying for that you",
    "would rather not be. We read every one.",
    "",
    "— The Renewly team",
    "",
    `Sent to ${input.email} because it was entered on ${copy.host}. If that was not you,`,
    "ignore this message — nothing further will be sent.",
  ].join("\n");
}

function firstName(name?: string | null): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

/** Shown to the reader, so it must be the real host rather than a hardcoded one. */
function siteHost(): string {
  try {
    return new URL(env.APP_URL).host;
  } catch {
    return "renewly.app";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
