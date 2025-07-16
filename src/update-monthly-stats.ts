import fetch from "node-fetch";
import { google } from "googleapis";
import { BetaAnalyticsDataClient } from "@google-analytics/data";
import { config } from "dotenv";

config();

// ---------- env ----------
const {
  GA_PROPERTY_ID,
  GOOGLE_CREDENTIALS,
  MICROCMS_SERVICE,
  MICROCMS_API_KEY = "",
  MICROCMS_ENDPOINT = "articles",
  SHEETS_ID,
} = process.env;
if (!GA_PROPERTY_ID || !GOOGLE_CREDENTIALS || !MICROCMS_SERVICE || !SHEETS_ID) {
  throw new Error("env vars missing");
}

// ---------- Google auth ----------
const credentials = JSON.parse(GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/analytics.readonly",
  ],
});
const sheets = google.sheets({ version: "v4", auth });
const analytics = new BetaAnalyticsDataClient({ credentials });

// ---------- helpers ----------
const ymLabel = (ym: string) => `${ym.slice(0, 4)}-${ym.slice(4)}`;

// Sheets overwrite helper
async function writeSheet(
  name: string,
  header: string[],
  rows: (string | number)[][]
) {
  // add sheet if not exist
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEETS_ID });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === name);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEETS_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: name } } }],
      },
    });
  }
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEETS_ID,
    range: `${name}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_ID,
    range: `${name}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [header, ...rows] },
  });
}

// ---------- fetch microCMS meta ----------
async function fetchPostMeta(): Promise<
  Map<string, { title: string; author: string }>
> {
  const map = new Map<string, { title: string; author: string }>();
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const url =
      `https://${MICROCMS_SERVICE}.microcms.io/api/v1/${MICROCMS_ENDPOINT}` +
      `?limit=${limit}&offset=${offset}&fields=id,title,author`;
    const res = await fetch(url, {
      headers: { "X-MICROCMS-API-KEY": MICROCMS_API_KEY },
    });
    if (!res.ok) {
      console.error("microCMS fetch error:", res.status, res.statusText);
      throw new Error("microCMS: " + JSON.stringify(await res.json()));
    }
    const { contents, totalCount } = (await res.json()) as any;
    contents.forEach((c: any) => {
      map.set(c.id, { title: c.title, author: c.author?.name ?? "" });
    });
    if (offset + limit >= totalCount) break;
  }
  if (map.size === 0) {
    throw new Error("No posts found in microCMS");
  }
  return map;
}

// ---------- fetch GA4 monthly views ----------
async function fetchMonthlyViews(): Promise<
  { ym: string; slug: string; views: number }[]
> {
  const [resp] = await analytics.runReport({
    property: `properties/${GA_PROPERTY_ID}`,
    dateRanges: [{ startDate: "2024-08-01", endDate: "yesterday" }],
    dimensions: [{ name: "yearMonth" }, { name: "pagePath" }],
    metrics: [{ name: "screenPageViews" }],
    dimensionFilter: {
      filter: {
        fieldName: "pagePath",
        stringFilter: {
          matchType: "BEGINS_WITH",
          value: `/${MICROCMS_ENDPOINT}/`,
        },
      },
    },
    limit: 100000,
  });
  return (resp.rows ?? []).map((r) => ({
    ym: r.dimensionValues?.[0]?.value || "",
    slug:
      r.dimensionValues?.[1]?.value
        ?.replace(new RegExp(`^/${MICROCMS_ENDPOINT}/`), "")
        ?.replace(/\/$/, "") || "",
    views: Number(r.metricValues?.[0]?.value || 0),
  }));
}

// ---------- main ----------
(async () => {
  const metaMap = await fetchPostMeta();
  const pvRows = await fetchMonthlyViews();

  // pvRows already contains all the data we need for long format

  // ---- blogs sheet (long format) ----
  const blogRows: (string | number)[][] = [];
  for (const { slug, ym, views } of pvRows) {
    if (!metaMap.has(slug)) continue;
    const meta = metaMap.get(slug)!;
    blogRows.push([slug, meta.title, meta.author, ymLabel(ym), views]);
  }
  // Sort by slug, then by month
  blogRows.sort((a, b) => {
    const slugCompare = String(a[0]).localeCompare(String(b[0]));
    if (slugCompare !== 0) return slugCompare;
    return String(a[3]).localeCompare(String(b[3]));
  });
  await writeSheet(
    "blogs",
    ["slug", "title", "author", "month", "views"],
    blogRows
  );
  console.log("blogs sheet updated", blogRows.length);

  // ---- authors sheet (long format) ----
  const authorMonthMap = new Map<string, number>();
  for (const { slug, ym, views } of pvRows) {
    if (!metaMap.has(slug)) continue;
    const author = metaMap.get(slug)!.author || "unknown";
    const key = `${author}|${ym}`;
    authorMonthMap.set(key, (authorMonthMap.get(key) || 0) + views);
  }
  const authorRows: (string | number)[][] = [];
  for (const [key, views] of authorMonthMap) {
    const [author, ym] = key.split("|");
    authorRows.push([author, ymLabel(ym), views]);
  }
  // Sort by author, then by month
  authorRows.sort((a, b) => {
    const authorCompare = String(a[0]).localeCompare(String(b[0]));
    if (authorCompare !== 0) return authorCompare;
    return String(a[1]).localeCompare(String(b[1]));
  });
  await writeSheet("authors", ["author", "month", "views"], authorRows);
  console.log("authors sheet updated", authorRows.length);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
