# microCMS ブログ / 著者 ― 月次 PV 集計自動更新セット

## ゴール

- **authors シート** … 著者ごとの月次ビュー数
- **blogs シート** … 記事（slug）ごとの月次ビュー数
- 毎日 **03:00 JST** に GitHub Actions が実行し、過去全期間分を再計算して Google Sheets に上書き

---

## 1. リポジトリ構成

```text
.
├── package.json
├── tsconfig.json
├── src/
│   └── update-monthly-stats.ts
└── .github/
    └── workflows/
        └── update-monthly-stats.yml
```

---

## 2. Secrets 一覧

| Key                       | 用途                          |
| ------------------------- | ----------------------------- |
| `GA_PROPERTY_ID`          | GA4 プロパティ ID             |
| `GOOGLE_CREDENTIALS_JSON` | サービスアカウント JSON       |
| `MICROCMS_SERVICE`        | microCMS サブドメイン         |
| `MICROCMS_API_KEY`        | 読み取り or 管理キー          |
| `SHEETS_ID`               | スプレッドシート ID (`/d/…/`) |

※ サービスアカウントは **Analytics Data API** と **Sheets API** を有効化し、Sheets に編集権付与。

---

## 3. GitHub Actions ワークフロー

```yaml
name: Update monthly PV stats

on:
  schedule:
    - cron: "0 18 * * *" # JST 03:00
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run start:monthly
        env:
          GA_PROPERTY_ID: ${{ secrets.GA_PROPERTY_ID }}
          GOOGLE_CREDENTIALS: ${{ secrets.GOOGLE_CREDENTIALS_JSON }}
          MICROCMS_SERVICE: ${{ secrets.MICROCMS_SERVICE }}
          MICROCMS_API_KEY: ${{ secrets.MICROCMS_API_KEY }}
          SHEETS_ID: ${{ secrets.SHEETS_ID }}
```

---

## 4. `package.json` 主要部分

```json
{
  "scripts": {
    "start:monthly": "tsx src/update-monthly-stats.ts"
  },
  "dependencies": {
    "@google-analytics/data": "^1.5.0",
    "googleapis": "^133.0.0",
    "node-fetch": "^3.5.0"
  },
  "devDependencies": {
    "tsx": "^4.7.0",
    "typescript": "^5.5.0"
  }
}
```

---

## 5. TypeScript 本体 (`src/update-monthly-stats.ts`)

```ts
import fetch from "node-fetch";
import { google } from "googleapis";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

// ---------- env ----------
const {
  GA_PROPERTY_ID,
  GOOGLE_CREDENTIALS,
  MICROCMS_SERVICE,
  MICROCMS_API_KEY = "",
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
      `https://${MICROCMS_SERVICE}.microcms.io/api/v1/blog` +
      `?limit=${limit}&offset=${offset}&fields=slug,title,author`;
    const res = await fetch(url, {
      headers: { "X-MICROCMS-API-KEY": MICROCMS_API_KEY },
    });
    if (!res.ok) throw new Error("microCMS: " + (await res.text()));
    const { contents, totalCount } = (await res.json()) as any;
    contents.forEach((c: any) =>
      map.set(c.slug, { title: c.title, author: c.author?.name ?? "" })
    );
    if (offset + limit >= totalCount) break;
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
        stringFilter: { matchType: "BEGINS_WITH", value: "/blog/" },
      },
    },
    limit: 100000,
  });
  return (resp.rows ?? []).map((r) => ({
    ym: r.dimensionValues[0].value,
    slug: r.dimensionValues[1].value
      .replace(/^\/blog\//, "")
      .replace(/\/$/, ""),
    views: Number(r.metricValues[0].value),
  }));
}

// ---------- main ----------
(async () => {
  const metaMap = await fetchPostMeta();
  const pvRows = await fetchMonthlyViews();

  // collects unique months
  const monthSet = new Set<string>(pvRows.map((r) => r.ym));
  const months = [...monthSet].sort(); // asc

  // ---- blogs sheet ----
  const blogMap = new Map<string, number[]>(); // slug -> views per month[]
  for (const { slug, ym, views } of pvRows) {
    if (!metaMap.has(slug)) continue;
    const idx = months.indexOf(ym);
    const arr = blogMap.get(slug) ?? Array(months.length).fill(0);
    arr[idx] = (arr[idx] || 0) + views;
    blogMap.set(slug, arr);
  }
  const blogRows = [...blogMap.entries()].map(([slug, arr]) => {
    const title = metaMap.get(slug)!.title;
    return [slug, title, ...arr];
  });
  await writeSheet(
    "blogs",
    ["slug", "title", ...months.map(ymLabel)],
    blogRows
  );
  console.log("blogs sheet updated", blogRows.length);

  // ---- authors sheet ----
  const authorMap = new Map<string, number[]>();
  for (const [slug, arr] of blogMap) {
    const author = metaMap.get(slug)!.author || "unknown";
    const cur = authorMap.get(author) ?? Array(months.length).fill(0);
    arr.forEach((v, i) => (cur[i] += v));
    authorMap.set(author, cur);
  }
  const authorRows = [...authorMap.entries()].map(([author, arr]) => [
    author,
    ...arr,
  ]);
  await writeSheet("authors", ["author", ...months.map(ymLabel)], authorRows);
  console.log("authors sheet updated", authorRows.length);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

---

## 6. Looker Studio 利用例

1. **Google Sheets コネクタ**で `authors` シートを追加
2. ディメンションを `author`、指標に各月列を選択し _折れ線グラフ_ で著者別推移を表示
3. 同様に `blogs` シートで記事別トレンドやヒートマップも作成可能

これで **月次 PV** が自動蓄積され、後から Looker Studio や BigQuery へインポートして多角的に分析できます 📝
