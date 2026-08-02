import { NextRequest, NextResponse } from "next/server";
import type { NewsArticle } from "@/lib/api/types";

export const dynamic = "force-dynamic";

const decodeXml = (value: string) =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const field = (item: string, name: string) => {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1]!.trim()) : "";
};

function parseFeed(xml: string, company: string): NewsArticle[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 3).flatMap((match) => {
    const item = match[1] ?? "";
    const rawTitle = field(item, "title");
    const url = field(item, "link");
    const publishedAt = field(item, "pubDate");
    const source = field(item, "source") || rawTitle.split(" - ").at(-1) || "News";
    const title = rawTitle.endsWith(` - ${source}`)
      ? rawTitle.slice(0, -(source.length + 3))
      : rawTitle;
    if (!title || !url || !publishedAt) return [];
    return [{ title, url, source, publishedAt: new Date(publishedAt).toISOString(), company }];
  });
}

export async function GET(request: NextRequest) {
  const companies = request.nextUrl.searchParams
    .getAll("company")
    .map((name) => name.trim().replace(/[^\p{L}\p{N} .&'-]/gu, ""))
    .filter(Boolean)
    .slice(0, 4);

  if (companies.length === 0) return NextResponse.json({ articles: [] });

  const settled = await Promise.allSettled(
    companies.map(async (company) => {
      const query = encodeURIComponent(`\"${company}\" company when:30d`);
      const response = await fetch(
        `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`,
        { next: { revalidate: 900 } },
      );
      if (!response.ok) throw new Error(`News feed returned ${response.status}`);
      return parseFeed(await response.text(), company);
    }),
  );

  const articles = settled
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, 8);

  const allFailed = settled.every((result) => result.status === "rejected");
  return NextResponse.json(
    { articles, partial: settled.some((result) => result.status === "rejected") },
    { status: allFailed ? 502 : 200 },
  );
}
