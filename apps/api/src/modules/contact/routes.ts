import { Hono } from "hono";
import { z } from "zod";
import { readJson } from "../../lib/http.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import type { AppEnv } from "../../types/context.js";
import { sendContactMessage } from "./service.js";

const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(320).email(),
  message: z.string().trim().min(1).max(5000),
});

export const contactRoutes = new Hono<AppEnv>();

// Public and unauthenticated, and every accepted request sends a mail, so this
// sits tighter than the waitlist: nobody has a legitimate reason to write in
// ten times a minute.
const contactLimiter = rateLimit({ limit: 10, windowMs: 60_000 });

contactRoutes.post("/", contactLimiter, async (c) => {
  // The request-scoped child logger already carries requestId, method and path,
  // so every line below correlates to one submission.
  const log = c.get("log");
  const input = await readJson(c, contactSchema);

  const result = await sendContactMessage(input, log);

  return c.json(
    { contact: { email: result.email, sentAt: result.sentAt.toISOString() } },
    201,
  );
});
