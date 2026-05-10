# セットアップガイド

## 1. ローカル開発環境

```bash
# 依存関係インストール
npm install

# 環境変数設定
cp .env.example .env
# .envを編集して各値を入力

# 開発サーバー起動
npm run dev
```

## 2. Claude API キーの取得

1. https://console.anthropic.com/ でアカウント作成
2. API Keys → Create Key
3. `.env` の `CLAUDE_API_KEY` に設定

## 3. Google Search Console API設定

### OAuth2認証情報の取得

1. Google Cloud Console → 新規プロジェクト作成
2. 「APIとサービス」→「ライブラリ」→ Search Console API を有効化
3. 「認証情報」→「認証情報を作成」→「OAuthクライアントID」
4. アプリケーションの種類：Webアプリ
5. クライアントID・シークレットを取得

### refresh_tokenの取得

```bash
# 以下のURLでブラウザ認証（client_idを置き換え）
https://accounts.google.com/o/oauth2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=https://www.googleapis.com/auth/webmasters.readonly&response_type=code&access_type=offline

# 取得したcodeでトークン取得
curl -X POST https://oauth2.googleapis.com/token \
  -d "code=YOUR_CODE&client_id=YOUR_CLIENT_ID&client_secret=YOUR_SECRET&redirect_uri=urn:ietf:wg:oauth:2.0:oob&grant_type=authorization_code"
```

## 4. GitHub Secrets設定

GitHubリポジトリ → Settings → Secrets and variables → Actions

| Secret名 | 値 |
|---|---|
| `CLAUDE_API_KEY` | Claude APIキー |
| `GSC_CLIENT_ID` | Google OAuthクライアントID |
| `GSC_CLIENT_SECRET` | Google OAuthクライアントシークレット |
| `GSC_REFRESH_TOKEN` | Google OAuthリフレッシュトークン |
| `SITE_URL` | `https://blog.example.com` |

## 5. Cloudflare Pagesデプロイ

1. Cloudflare Dashboard → Workers & Pages → Create
2. 「Connect to Git」→ GitHubリポジトリを選択
3. ビルド設定：
   - Framework preset: Astro
   - Build command: `npm run build`
   - Build output directory: `dist`
4. 環境変数に `SITE_URL` を追加
5. カスタムドメイン設定

## 6. キーワードリスト管理

`data/keywords/keywords.json` を編集してキーワードを追加します。

```json
{
  "keyword": "ターゲットキーワード",
  "intent": "検索意図の説明",
  "target": "ターゲット読者",
  "tags": ["タグ1", "タグ2"],
  "generated": false
}
```

`"generated": false` の記事が順番に生成されます。

## 7. 手動実行

```bash
# 記事を1件生成
npm run generate

# GSC分析実行
npm run analyze

# リライト実行
npm run rewrite

# OG画像生成
npm run og

# 内部リンク追加
npm run link
```

## 8. 自動化スケジュール

| ワークフロー | 実行時刻(JST) | 内容 |
|---|---|---|
| daily-generate | AM 5:00 | 記事生成・OG画像・内部リンク |
| seo-analysis | AM 6:00 | Search Console分析 |
| auto-rewrite | AM 7:00 | 低パフォーマンス記事のリライト |

GitHub Actions → 各ワークフロー → Run workflow で手動実行も可能。
