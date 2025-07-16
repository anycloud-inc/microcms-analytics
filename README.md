# microCMS Analytics

Google Analytics 4 と microCMS のデータを統合し、月次 PV 数を Google Sheets に自動集計するシステムです。

## 概要

このプロジェクトは以下の機能を提供します：

- microCMS ブログの記事別・著者別の月次 PV 数を自動集計
- Google Sheets への定期的なデータ更新（毎日午前 3 時 JST）
- GitHub Actions による完全自動化

## セットアップガイド

### 1. 前提条件

- Google Cloud Project が作成済み
- microCMS の API キーが発行済み
- Google Sheets が作成済み

### 2. Google Cloud 設定

#### 2.1 必要な API を有効化

1. [Google Cloud Console](https://console.cloud.google.com/)にアクセス
2. 以下の API を有効化：
   - Google Analytics Data API
   - Google Sheets API

#### 2.2 サービスアカウントの作成

1. 「IAM と管理」→「サービスアカウント」から新規作成
2. 適切な名前を付けて作成（例：`microcms-analytics-bot`）
3. JSON キーを作成してダウンロード

#### 2.3 権限設定

1. **Google Analytics**: GA4 プロパティの「管理」→「アカウントのアクセス管理」でサービスアカウントのメールを追加（閲覧者権限）
2. **Google Sheets**: 対象のスプレッドシートでサービスアカウントのメールに編集権限を付与

### 3. microCMS 設定

1. microCMS の管理画面から「設定」→「API キー」へ
2. 読み取り専用の API キーを作成（または既存のものを使用）

### 4. GitHub 設定

#### 4.1 リポジトリの Secrets と Variables 設定

リポジトリの「Settings」→「Secrets and variables」→「Actions」で以下を追加：

**Secrets（機密情報）：**
| Secret 名                 | 値             | 説明                                            |
| ------------------------- | -------------- | ----------------------------------------------- |
| `GOOGLE_CREDENTIALS_JSON` | `{...}`        | サービスアカウントの JSON 全文                  |
| `MICROCMS_API_KEY`        | `xxxxx`        | microCMS の API キー                            |

**Variables（設定値）：**
| Variable 名               | 値             | 説明                                            |
| ------------------------- | -------------- | ----------------------------------------------- |
| `GA_PROPERTY_ID`          | `123456789`    | GA4 のプロパティ ID                             |
| `MICROCMS_SERVICE`        | `your-service` | microCMS のサブドメイン                         |
| `MICROCMS_ENDPOINT`       | `articles`     | microCMS の API エンドポイント（デフォルト：articles） |
| `SHEETS_ID`               | `1abc...xyz`   | スプレッドシート ID（URL の`/d/`と`/edit`の間） |

#### 4.2 Actions 権限の確認

「Settings」→「Actions」→「General」で以下を確認：

- Actions permissions: "Allow all actions and reusable workflows"
- Workflow permissions: "Read and write permissions"

### 5. ローカル開発環境

#### 5.1 依存関係のインストール

```bash
pnpm install
```

#### 5.2 環境変数の設定

`.env`ファイルを作成：

```env
GA_PROPERTY_ID=123456789
GOOGLE_CREDENTIALS={"type":"service_account",...}
MICROCMS_SERVICE=your-service
MICROCMS_API_KEY=xxxxx
MICROCMS_ENDPOINT=articles
SHEETS_ID=1abc...xyz
```

#### 5.3 手動実行

```bash
npm run start:monthly
```

## 出力形式

### authors シート

| author   | 2024-08 | 2024-09 | 2024-10 | ... |
| -------- | ------- | ------- | ------- | --- |
| 山田太郎 | 1,234   | 2,345   | 3,456   | ... |
| 鈴木花子 | 567     | 890     | 1,234   | ... |

### blogs シート

| slug        | title          | 2024-08 | 2024-09 | 2024-10 | ... |
| ----------- | -------------- | ------- | ------- | ------- | --- |
| hello-world | はじめての記事 | 123     | 234     | 345     | ... |
| tech-tips   | 技術 Tips      | 456     | 567     | 678     | ... |

## トラブルシューティング

### エラー: "env vars missing"

必要な環境変数が設定されていません。GitHub Secrets またはローカルの ENV ファイルを確認してください。

### エラー: "The caller does not have permission"

サービスアカウントの権限が不足しています：

- GA4: プロパティへの閲覧権限を確認
- Sheets: スプレッドシートへの編集権限を確認

### エラー: "microCMS: 401"

microCMS の API キーが無効です。正しいキーが設定されているか確認してください。

### データが更新されない

1. GitHub Actions のログを確認
2. 手動で Workflow を実行して動作確認
3. GA4 のデータ反映には最大 24 時間かかる場合があります

## カスタマイズ

### 集計期間の変更

`src/update-monthly-stats.ts`の以下の部分を修正：

```typescript
dateRanges: [{ startDate: "2024-08-01", endDate: "yesterday" }],
```

### 集計対象パスの変更

```typescript
stringFilter: { matchType: "BEGINS_WITH", value: "/blog/" },
```

### 実行時刻の変更

`.github/workflows/update-monthly-stats.yml`の cron 式を修正：

```yaml
- cron: "0 18 * * *" # JST 03:00
```

## ライセンス

MIT
