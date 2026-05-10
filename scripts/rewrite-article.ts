/**
 * AIリライトスクリプト（Playwright版）
 * analyze-gsc.tsが出力したrewrite-candidates.jsonを読み込み、
 * Playwright経由でClaude.ai Webを操作して記事をリライトする
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const INPUT_SELECTORS = ['div[contenteditable="true"]', 'textarea', 'div[contenteditable]'];
const SUBMIT_SELECTORS = ['button[aria-label*="Send"]', 'button[type="submit"]'];
const OUTPUT_SELECTORS = [
  '[data-message-role="assistant"]',
  '.font-claude-message',
  'div[class*="font-claude"]',
  'div[class*="AssistantMessage"]',
  'div.prose',
];

interface RewriteCandidate {
  page: string;
  reason: 'low-ctr' | 'rank-drop' | 'impression-surge';
  metrics: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  };
}

function pageToFilePath(pageUrl: string): string {
  const url = new URL(pageUrl);
  const slug = url.pathname
    .replace(/^\/ai-seo-blog\/blog\//, '')
    .replace(/\/$/, '');
  return path.join(ROOT, 'src', 'content', 'blog', `${slug}.mdx`);
}

// ─── Playwright ───────────────────────────────────────────────────────────────

async function buildContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
  });
  const cookiesJson = process.env.CLAUDE_COOKIES;
  if (!cookiesJson) throw new Error('CLAUDE_COOKIES が未設定です');
  await context.addCookies(JSON.parse(cookiesJson));
  return context;
}

async function sendPromptAndWait(page: Page, prompt: string, maxWaitMs = 120_000): Promise<string> {
  let inputBox = null;
  for (const sel of INPUT_SELECTORS) {
    inputBox = await page.$(sel);
    if (inputBox) break;
  }
  if (!inputBox) throw new Error('入力ボックスが見つかりません');

  await inputBox.fill(prompt);

  let sent = false;
  for (const sel of SUBMIT_SELECTORS) {
    const btn = await page.$(sel);
    if (btn) { await btn.click(); sent = true; break; }
  }
  if (!sent) await page.keyboard.press('Control+Enter');

  const deadline = Date.now() + maxWaitMs;
  let best = '';
  let stableCount = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const candidates: string[] = [];
    for (const sel of OUTPUT_SELECTORS) {
      for (const el of await page.$$(sel)) {
        const t = (await el.innerText().catch(() => '')).trim();
        if (t.length >= 20) candidates.push(t);
      }
    }
    if (candidates.length) {
      const current = candidates.reduce((a, b) => a.length > b.length ? a : b);
      if (current === best) stableCount++;
      else { best = current; stableCount = 0; }
      if (stableCount >= 2 && best.length >= 20) return best;
    }
  }
  return best;
}

// ─── リライト処理 ─────────────────────────────────────────────────────────────

async function rewriteForLowCtr(
  page: Page,
  content: string,
  metrics: RewriteCandidate['metrics'],
): Promise<string> {
  const prompt = `以下の記事のタイトルとmeta descriptionを改善してください。

現状指標:
- 表示回数: ${metrics.impressions}
- CTR: ${metrics.ctr.toFixed(2)}%
- 順位: ${metrics.position.toFixed(1)}位

改善目標: CTRを3%以上に向上させる

記事内容:
${content}

出力: フロントマターのtitleとdescriptionのみJSONで返してください（説明不要）。
{"title": "...", "description": "..."}`;

  const output = await sendPromptAndWait(page, prompt, 60_000);
  const jsonMatch = output.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return content;

  try {
    const { title, description } = JSON.parse(jsonMatch[0]);
    return content
      .replace(/^title: ".*"/m, `title: "${title}"`)
      .replace(/^description: ".*"/m, `description: "${description}"`);
  } catch {
    return content;
  }
}

async function rewriteBody(
  page: Page,
  content: string,
  metrics: RewriteCandidate['metrics'],
): Promise<string> {
  const match = content.match(/^(---[\s\S]*?---\n)([\s\S]*)$/);
  if (!match) return content;
  const [, frontmatter, body] = match;

  const prompt = `以下の記事をリライトしてください。

現状指標:
- 順位: ${metrics.position.toFixed(1)}位（目標: 10位以内）
- 表示回数: ${metrics.impressions}
- CTR: ${metrics.ctr.toFixed(2)}%

改善ポイント:
- 見出し構成の最適化
- E-E-A-Tの強化（具体例・データ追加）
- 読みやすさの向上

記事本文:
${body}

[REWRITE_RESULT]
（リライト後の本文のみMarkdownで出力。フロントマター不要）
[/REWRITE_RESULT]`;

  const output = await sendPromptAndWait(page, prompt, 180_000);

  const tagMatch = output.match(/\[REWRITE_RESULT\]([\s\S]*?)\[\/REWRITE_RESULT\]/i);
  const rewritten = tagMatch ? tagMatch[1].trim() : body;

  const today = new Date().toISOString().split('T')[0];
  const updatedFrontmatter = frontmatter.replace(/---\n$/, `updatedDate: ${today}\n---\n`);
  return updatedFrontmatter + rewritten;
}

// ─── メイン ───────────────────────────────────────────────────────────────────

async function main() {
  const candidatesPath = path.join(ROOT, 'data', 'rewrite-candidates.json');
  const raw = await fs.readFile(candidatesPath, 'utf-8').catch(() => '[]');
  const candidates: RewriteCandidate[] = JSON.parse(raw);

  if (candidates.length === 0) {
    console.log('リライト候補なし');
    return;
  }

  const target = candidates[0];
  console.log(`リライト対象: ${target.page} (理由: ${target.reason})`);

  const filePath = pageToFilePath(target.page);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    console.error(`ファイルが見つかりません: ${filePath}`);
    return;
  }

  const browser: Browser = await chromium.launch({ headless: false });
  try {
    const context = await buildContext(browser);
    const page = await context.newPage();
    await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('div[contenteditable="true"]', { timeout: 30_000 });

    let updated: string;
    if (target.reason === 'low-ctr') {
      updated = await rewriteForLowCtr(page, content, target.metrics);
      console.log('タイトル・description改善完了');
    } else {
      updated = await rewriteBody(page, content, target.metrics);
      console.log('本文リライト完了');
    }

    await context.close();
    await fs.writeFile(filePath, updated, 'utf-8');

    await fs.writeFile(
      candidatesPath,
      JSON.stringify(candidates.slice(1), null, 2),
      'utf-8',
    );

    console.log(`更新完了: ${filePath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('エラー:', err.message);
  process.exit(1);
});
