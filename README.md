# AI SEO自動運用ブログシステム

AIによるSEO記事の自動生成・公開・分析・改善ループを実現するブログシステム。

## 技術スタック

- **フロントエンド**: Astro + MDX + Tailwind CSS
- **ホスティング**: Cloudflare Pages
- **バージョン管理**: GitHub
- **自動化**: GitHub Actions
- **AI**: Claude API (claude-sonnet-4-6)
- **SEO分析**: Google Search Console API

## セットアップ

```bash
npm install
npm run dev
```

## 環境変数

`.env.example` を `.env` にコピーして各値を設定してください。

## 自動化フロー

| ワークフロー | 実行時刻 | 内容 |
|---|---|---|
| daily-generate | 毎日 AM 5:00 | 記事自動生成・公開 |
| seo-analysis | 毎日 AM 6:00 | Search Console分析 |
| auto-rewrite | 毎日 AM 7:00 | AI自動リライト |

## ディレクトリ構成

```
ai-seo-blog/
├─ src/
│   ├─ pages/          # Astroページ
│   ├─ layouts/        # レイアウトコンポーネント
│   ├─ components/     # UIコンポーネント
│   └─ content/blog/   # MDX記事
├─ scripts/            # 自動化スクリプト
├─ .github/workflows/  # GitHub Actions
├─ data/keywords/      # キーワードリスト
└─ public/             # 静的ファイル・OG画像
```
