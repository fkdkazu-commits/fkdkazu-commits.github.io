/**
 * Playwright経由でClaude.ai Webを操作してSEO記事を自動生成する
 *
 * seo-article-pipeline/backend/services/playwright_handler.py のTypeScript移植版
 * APIキー不要 - Claude Proサブスクリプションのセッションを使用
 *
 * 実行方法:
 *   CLAUDE_COOKIES='[...]' npm run generate
 *
 * GitHub Actions での実行:
 *   secrets.CLAUDE_COOKIES を環境変数として渡す
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(ROOT, 'src', 'content', 'blog');

const CLAUDE_URL = 'https://claude.ai';
const CLAUDE_NEW_CHAT = 'https://claude.ai/new';

// claude.ai の入力欄・出力欄セレクター (playwright_handler.py に準拠)
const INPUT_SELECTORS = [
  'div[contenteditable="true"]',
  'textarea',
  'div[contenteditable]',
];
const SUBMIT_SELECTORS = [
  'button[aria-label*="Send"]',
  'button[type="submit"]',
];
const OUTPUT_SELECTORS = [
  '[data-message-role="assistant"]',
  '[data-testid*="assistant"]',
  '.font-claude-message',
  'div[class*="font-claude"]',
  'div[class*="message-content"]',
  'div[class*="AssistantMessage"]',
  'main article',
  'div.prose',
];

// playwright_handler.py と同じノイズパターン
const NOISE_PATTERNS = [/\bClaude\b/g, /\bNew chat\b/g, /\bUpgrade\b/g, /\bSettings\b/g];

interface Keyword {
  keyword: string;
  intent: string;
  target: string;
  tags: string[];
  generated?: boolean;
}

// ─── Playwright セッション ───────────────────────────────────────────────────

async function buildContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
  });

  // Bot検知回避
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en'] });
  });

  // GitHub Secrets から Cookie を注入
  const cookiesJson = process.env.CLAUDE_COOKIES;
  if (!cookiesJson) {
    throw new Error('環境変数 CLAUDE_COOKIES が設定されていません。SETUP.md を参照してください。');
  }
  const cookies = JSON.parse(cookiesJson);
  await context.addCookies(cookies);
  console.log(`✓ Claude.ai Cookie を注入 (${cookies.length}件)`);
  return context;
}

async function waitForInputBox(page: Page, timeoutMs = 30_000): Promise<void> {
  for (const selector of INPUT_SELECTORS) {
    try {
      await page.waitForSelector(selector, { timeout: timeoutMs });
      return;
    } catch {
      continue;
    }
  }
  // デバッグ: 現在のページ状態をログ出力
  const url = page.url();
  const title = await page.title().catch(() => '取得失敗');
  const bodySnippet = await page.innerText('body').catch(() => '').then(t => t.slice(0, 300));
  console.error(`現在のURL: ${url}`);
  console.error(`ページタイトル: ${title}`);
  console.error(`ページ内容（先頭300字）: ${bodySnippet}`);
  throw new Error('Claude.ai の入力ボックスが見つかりません。Cookieの有効期限が切れている可能性があります。');
}

async function submitPrompt(page: Page, promptText: string): Promise<void> {
  let inputBox = null;
  for (const selector of INPUT_SELECTORS) {
    inputBox = await page.$(selector);
    if (inputBox) break;
  }
  if (!inputBox) throw new Error('入力ボックスが見つかりません');

  await inputBox.fill(promptText);
  console.log(`✓ プロンプト入力 (${promptText.length}文字)`);

  let sent = false;
  for (const selector of SUBMIT_SELECTORS) {
    const btn = await page.$(selector);
    if (btn) {
      await btn.click();
      sent = true;
      break;
    }
  }
  if (!sent) {
    await page.keyboard.press('Control+Enter');
  }
  console.log('✓ プロンプト送信');
}

/**
 * playwright_handler.py の _wait_for_output に相当
 * 安定した出力を検出するまでポーリング
 */
async function waitForOutput(
  page: Page,
  submittedPrompt: string,
  maxWaitMs = 300_000,
  minChars = 200,
): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  let bestText = '';
  let stableCount = 0;
  let iteration = 0;

  while (Date.now() < deadline) {
    iteration++;
    await page.waitForTimeout(2000);

    try {
      // タグ付きブロックを最優先で抽出
      const bodyText = await page.innerText('body').catch(() => '');
      const tagged = extractTaggedBlock(bodyText);
      if (tagged && tagged.length >= minChars) {
        console.log(`✓ タグ付きブロック検出: ${tagged.length}文字`);
        return tagged;
      }

      // セレクターから候補を収集
      const candidates: string[] = [];
      for (const selector of OUTPUT_SELECTORS) {
        const elements = await page.$$(selector);
        for (const el of elements) {
          const text = (await el.innerText().catch(() => '')).trim();
          if (text.length >= 40 && !looksLikeUserPrompt(text, submittedPrompt)) {
            candidates.push(text);
          }
        }
      }

      if (candidates.length > 0) {
        const current = candidates.reduce((a, b) => (a.length > b.length ? a : b));
        if (current === bestText) {
          stableCount++;
        } else {
          bestText = current;
          stableCount = 0;
          if (iteration % 5 === 0) console.log(`  出力更新中: ${current.length}文字`);
        }
        // 2回連続安定 + 最小文字数を満たしたら確定
        if (stableCount >= 2 && current.length >= minChars) {
          console.log(`✓ 出力確定: ${current.length}文字`);
          return bestText;
        }
      }
    } catch {
      // ページ遷移等の一時的エラーは無視
    }
  }

  if (bestText.length >= minChars) {
    console.warn(`⚠ タイムアウト - ベスト出力を採用: ${bestText.length}文字`);
    return bestText;
  }
  throw new Error(`タイムアウト: ${maxWaitMs / 1000}秒以内に${minChars}文字以上の出力が得られませんでした`);
}

function extractTaggedBlock(text: string): string | null {
  const tags = ['ARTICLE_DRAFT', 'FACTCHECKED_ARTICLE'];
  for (const tag of tags) {
    const re = new RegExp(`\\[\\s*${tag}\\s*\\]([\\s\\S]*?)\\[\\s*/\\s*${tag}\\s*\\]`, 'i');
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

function looksLikeUserPrompt(candidate: string, prompt: string): boolean {
  if (!candidate || !prompt || candidate.length < 80 || prompt.length < 80) return false;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const nc = norm(candidate);
  const np = norm(prompt);
  if (nc.includes(np.slice(0, 200)) || np.includes(nc.slice(0, 200))) return true;
  return false;
}

// ─── 記事生成ロジック ─────────────────────────────────────────────────────────

function buildArticlePrompt(kw: Keyword): string {
  return `以下の条件でSEO記事を書いてください。

【キーワード】${kw.keyword}
【検索意図】${kw.intent}
【ターゲット読者】${kw.target}

【要件】
- 文字数: 2,000〜3,000字
- H2見出しを3〜5個、必要に応じてH3を追加
- E-E-A-T（経験・専門性・権威性・信頼性）を意識した具体的な内容
- 末尾にFAQセクション（Q&A形式）を3問追加
- meta descriptionを末尾に1行追加（120字以内、「meta_description:」で始める）

【出力形式】
[ARTICLE_DRAFT]
# タイトル

（本文をMarkdown形式で記述）

## よくある質問

### 質問1
回答1

[/ARTICLE_DRAFT]
meta_description: （ここにmeta descriptionを記述）`;
}

function parseArticleOutput(raw: string): { title: string; body: string; description: string } {
  // タグ内の本文を取得
  const inner = raw.replace(/\[\/?\s*ARTICLE_DRAFT\s*\]/gi, '').trim();

  // タイトル (最初の # 行)
  const titleMatch = inner.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : 'タイトル未取得';

  // meta_description
  const descMatch = raw.match(/meta_description:\s*(.+)/i);
  const description = descMatch ? descMatch[1].trim() : '';

  // 本文 (タイトル行とmeta行を除く)
  const body = inner
    .replace(/^#\s+.+\n?/m, '')
    .replace(/meta_description:.+$/im, '')
    .trim();

  return { title, body, description };
}

function buildMdx(kw: Keyword, title: string, body: string, description: string): string {
  const today = new Date().toISOString().split('T')[0];
  return `---
title: "${title.replace(/"/g, '\\"')}"
description: "${description.replace(/"/g, '\\"')}"
pubDate: ${today}
keyword: "${kw.keyword}"
tags: ${JSON.stringify(kw.tags)}
draft: false
---

${body}
`;
}

// ─── メイン ───────────────────────────────────────────────────────────────────

async function main() {
  // キーワード読み込み
  const kwPath = path.join(ROOT, 'data', 'keywords', 'keywords.json');
  const keywords: Keyword[] = JSON.parse(await fs.readFile(kwPath, 'utf-8'));
  const target = keywords.find((k) => !k.generated);

  if (!target) {
    console.log('生成対象のキーワードがありません（すべて generated: true）');
    return;
  }

  console.log(`\n記事生成開始: "${target.keyword}"`);

  let browser: Browser | null = null;
  try {
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.CHROME_PATH,
    ].filter(Boolean) as string[];

    const executablePath = chromePaths.find((p) => {
      try { return require('fs').existsSync(p); } catch { return false; }
    });

    browser = await chromium.launch({
      headless: false,
      executablePath,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await buildContext(browser);
    const page = await context.newPage();

    // Claude.ai へ移動
    console.log('Claude.ai に接続中...');
    await page.goto(CLAUDE_NEW_CHAT, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // ログイン確認
    await waitForInputBox(page, 30_000);
    console.log('✓ Claude.ai ログイン確認済み');

    // ページが完全に安定するまで待機（ナビゲーション完了を待つ）
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);

    // プロンプト送信
    const prompt = buildArticlePrompt(target);
    await submitPrompt(page, prompt);

    // 出力待機（最大5分）
    console.log('記事生成中（最大5分待機）...');
    const rawOutput = await waitForOutput(page, prompt, 300_000, 500);

    // パース
    const { title, body, description } = parseArticleOutput(rawOutput);
    console.log(`✓ タイトル取得: ${title}`);

    // MDX保存
    await fs.mkdir(BLOG_DIR, { recursive: true });
    const slug = target.keyword.replace(/\s+/g, '-').toLowerCase().replace(/[^\w-]/g, '');
    const mdxPath = path.join(BLOG_DIR, `${slug}.mdx`);
    await fs.writeFile(mdxPath, buildMdx(target, title, body, description), 'utf-8');
    console.log(`✓ MDX保存: src/content/blog/${slug}.mdx`);

    // generated フラグ更新
    target.generated = true;
    await fs.writeFile(kwPath, JSON.stringify(keywords, null, 2), 'utf-8');

    await context.close();
  } finally {
    if (browser) await browser.close();
  }

  console.log('\n記事生成完了');
}

main().catch((err) => {
  console.error('エラー:', err.message);
  process.exit(1);
});
