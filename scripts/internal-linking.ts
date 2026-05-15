/**
 * 内部リンク自動追加スクリプト
 * PlaywrightでClaude.aiを操作して関連記事を分析し、内部リンクを挿入する
 * Claude APIキー不要 - 永続プロファイル（~/.claude-profiles/ai-seo-blog）で動作
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(ROOT, 'src', 'content', 'blog');
const PROFILE_DIR = 'C:\\Users\\fkdka\\.claude-profiles\\ai-seo-blog';

const INPUT_SELECTORS = ['div[contenteditable="true"]', 'textarea', 'div[contenteditable]'];
const SUBMIT_SELECTORS = ['button[aria-label*="Send"]', 'button[type="submit"]'];
const OUTPUT_SELECTORS = [
  '[data-message-role="assistant"]',
  '.font-claude-message',
  'div[class*="font-claude"]',
  'div[class*="AssistantMessage"]',
  'div.prose',
];

interface ArticleSummary {
  slug: string;
  title: string;
  keyword: string;
}

function extractFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^"|"$/g, '');
    result[key] = val;
  }
  return result;
}

async function loadAllArticles(): Promise<ArticleSummary[]> {
  const files = await fs.readdir(BLOG_DIR).catch(() => [] as string[]);
  const articles: ArticleSummary[] = [];
  for (const file of files.filter((f) => f.endsWith('.mdx'))) {
    const content = await fs.readFile(path.join(BLOG_DIR, file), 'utf-8');
    const fm = extractFrontmatter(content);
    if (fm.title) {
      articles.push({ slug: file.replace('.mdx', ''), title: fm.title, keyword: fm.keyword || '' });
    }
  }
  return articles;
}

// ─── Playwright ───────────────────────────────────────────────────────────────

async function buildContext(): Promise<BrowserContext> {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
  });
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

  // 出力待機
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

async function findRelatedSlugs(
  page: Page,
  target: ArticleSummary,
  others: ArticleSummary[],
): Promise<string[]> {
  if (others.length === 0) return [];

  const prompt = `以下のターゲット記事に内部リンクを貼るべき関連記事を選んでください。
最大3件選び、slugのみをJSON配列で返してください（説明不要）。

ターゲット記事:
タイトル: ${target.title}
キーワード: ${target.keyword}

候補記事:
${others.map((a) => `slug: ${a.slug} | タイトル: ${a.title} | キーワード: ${a.keyword}`).join('\n')}

出力例: ["slug-a", "slug-b"]`;

  const output = await sendPromptAndWait(page, prompt, 60_000);
  const match = output.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as string[];
  } catch {
    return [];
  }
}

async function insertLinks(targetSlug: string, related: ArticleSummary[]): Promise<void> {
  const filePath = path.join(BLOG_DIR, `${targetSlug}.mdx`);
  let content = await fs.readFile(filePath, 'utf-8');

  if (content.includes('## 関連記事')) return;

  const linkSection = `\n\n## 関連記事\n\n${related.map((a) => `- [${a.title}](/blog/${a.slug}/)`).join('\n')}\n`;

  if (content.includes('## よくある質問')) {
    content = content.replace('## よくある質問', `${linkSection}\n## よくある質問`);
  } else {
    content += linkSection;
  }

  await fs.writeFile(filePath, content, 'utf-8');
  console.log(`✓ 内部リンク追加: ${targetSlug} → ${related.map((a) => a.slug).join(', ')}`);
}

// ─── メイン ───────────────────────────────────────────────────────────────────

async function main() {
  const articles = await loadAllArticles();
  if (articles.length < 2) {
    console.log('記事が2件未満のため内部リンク処理をスキップ');
    return;
  }

  // 最新記事（更新日時が最新）を対象にする
  const files = await fs.readdir(BLOG_DIR);
  const sorted = (
    await Promise.all(
      files.filter((f) => f.endsWith('.mdx')).map(async (f) => ({
        f,
        mtime: (await fs.stat(path.join(BLOG_DIR, f))).mtime,
      })),
    )
  ).sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const targetSlug = sorted[0].f.replace('.mdx', '');
  const target = articles.find((a) => a.slug === targetSlug);
  if (!target) return;

  console.log(`内部リンク解析: ${target.title}`);

  const context = await buildContext();
  try {
    const pages = context.pages();
    const page: Page = pages.length > 0 ? pages[0] : await context.newPage();
    await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('div[contenteditable="true"]', { timeout: 60_000 });

    const others = articles.filter((a) => a.slug !== targetSlug);
    const slugs = await findRelatedSlugs(page, target, others);

    const related = others.filter((a) => slugs.includes(a.slug));
    if (related.length === 0) {
      console.log('関連記事なし');
      return;
    }
    await insertLinks(targetSlug, related);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('エラー:', err.message);
  process.exit(1);
});
