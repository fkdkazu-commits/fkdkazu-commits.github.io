/**
 * Playwright経由でClaude.ai Webを操作してSEO記事を自動生成する
 * 5ステップパイプライン: リサーチ→記事生成→ファクトチェック→品質向上→内部リンク
 *
 * APIキー不要 - Claude Proサブスクリプションのセッションを使用
 *
 * 実行方法:
 *   CLAUDE_COOKIES='[...]' npm run generate
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(ROOT, 'src', 'content', 'blog');
const PROMPT_DIR = path.join(ROOT, 'data', 'prompts');

const CLAUDE_NEW_CHAT = 'https://claude.ai/new';

const INPUT_SELECTORS = [
  'div[contenteditable="true"]',
  'textarea',
  'div[contenteditable]',
];
const SUBMIT_SELECTORS = [
  'button[aria-label*="Send"]',
  'button[type="submit"]',
];

const STEP_TAGS = [
  'SEO_RESEARCH_REPORT',
  'ARTICLE_DRAFT',
  'ARTICLE_DRAFT',
  'ARTICLE_DRAFT',
  'ARTICLE_DRAFT',
];
const STEP_NAMES = ['リサーチ', '記事生成', 'ファクトチェック', '品質向上', '内部リンク'];
const STEP_TIMEOUTS = [
  600_000,   // Step 1: リサーチ     10分
  1_800_000, // Step 2: 記事生成     30分（8000字以上）
  1_200_000, // Step 3: ファクトチェック 20分
  900_000,   // Step 4: 品質向上     15分
  600_000,   // Step 5: 内部リンク   10分
];
const STEP_FILES = [
  'step1-research.txt',
  'step2-article.txt',
  'step3-factcheck.txt',
  'step4-quality.txt',
  'step5-links.txt',
];

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

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en'] });
  });

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
  const url = page.url();
  const title = await page.title().catch(() => '取得失敗');
  const bodySnippet = await page.innerText('body').catch(() => '').then((t) => t.slice(0, 300));
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
  if (!sent) await page.keyboard.press('Control+Enter');
  console.log('✓ プロンプト送信');
}

// ─── 出力検出 ─────────────────────────────────────────────────────────────────

function countTaggedBlocks(text: string, tag: string): number {
  const re = new RegExp(`\\[\\s*${tag}\\s*\\]([\\s\\S]*?)\\[\\s*/\\s*${tag}\\s*\\]`, 'gi');
  return [...text.matchAll(re)].length;
}

/**
 * DOM Range APIを使い [TAG]...[/TAG] の最後のブロックをMarkdown形式で抽出。
 * innerText では失われる ## 見出しやコードフェンスを保持する。
 */
async function extractLastTaggedBlockMarkdown(page: Page, tag: string): Promise<string | null> {
  return await page.evaluate((tagName: string) => {
    const openTag = `[${tagName}]`;
    const closeTag = `[/${tagName}]`;

    // 全テキストノードを収集
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) textNodes.push(n as Text);

    // 開始・終了タグの位置を収集
    const opens: [Text, number][] = [];
    const closes: [Text, number][] = [];
    for (const tn of textNodes) {
      const c = tn.textContent ?? '';
      let p = 0;
      while ((p = c.indexOf(openTag, p)) !== -1) {
        opens.push([tn, p + openTag.length]);
        p += openTag.length;
      }
      p = 0;
      while ((p = c.indexOf(closeTag, p)) !== -1) {
        closes.push([tn, p]);
        p += closeTag.length;
      }
    }

    const pairCount = Math.min(opens.length, closes.length);
    if (pairCount === 0) return null;

    const [openNode, openOffset] = opens[pairCount - 1];
    const [closeNode, closeOffset] = closes[pairCount - 1];

    // DOM Range でタグ間のコンテンツを取得
    let fragment: DocumentFragment;
    try {
      const range = document.createRange();
      range.setStart(openNode, openOffset);
      range.setEnd(closeNode, closeOffset);
      fragment = range.cloneContents();
    } catch {
      return null;
    }

    // HTML → Markdown 変換
    function convert(node: Node): string {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      const inner = () => Array.from(el.childNodes).map(convert).join('');

      switch (tag) {
        case 'h1': return '\n# ' + inner().trim() + '\n\n';
        case 'h2': return '\n## ' + inner().trim() + '\n\n';
        case 'h3': return '\n### ' + inner().trim() + '\n\n';
        case 'h4': return '\n#### ' + inner().trim() + '\n\n';
        case 'p':  return inner().trim() + '\n\n';
        case 'strong': case 'b': return '**' + inner() + '**';
        case 'em':     case 'i': return '*'  + inner() + '*';
        case 'code': {
          if (el.closest('pre')) return el.textContent ?? '';
          return '`' + (el.textContent ?? '') + '`';
        }
        case 'pre': {
          const codeEl = el.querySelector('code');
          const langMatch = (codeEl?.className ?? '').match(/language-(\w+)/);
          const lang = langMatch ? langMatch[1] : '';
          const code = (codeEl?.textContent ?? el.textContent ?? '').replace(/\n$/, '');
          return '\n```' + lang + '\n' + code + '\n```\n\n';
        }
        case 'ul': {
          return Array.from(el.children).map(li => '- ' + convert(li).trim()).join('\n') + '\n\n';
        }
        case 'ol': {
          return Array.from(el.children)
            .map((li, i) => (i + 1) + '. ' + convert(li).trim())
            .join('\n') + '\n\n';
        }
        case 'li': return inner();
        case 'a': return '[' + inner() + '](' + (el.getAttribute('href') ?? '') + ')';
        case 'table': return '\n' + inner() + '\n';
        case 'thead': case 'tbody': return inner();
        case 'tr': {
          const cells = Array.from(el.children).map(td => convert(td).trim());
          const row = '| ' + cells.join(' | ') + ' |';
          const isHeader = el.parentElement?.tagName.toLowerCase() === 'thead';
          const sep = isHeader ? '\n| ' + cells.map(() => '---').join(' | ') + ' |' : '';
          return row + sep + '\n';
        }
        case 'th': case 'td': return inner();
        case 'br': return '\n';
        case 'hr': return '\n---\n\n';
        case 'blockquote': return '> ' + inner().trim().split('\n').join('\n> ') + '\n\n';
        default: return inner();
      }
    }

    const container = document.createElement('div');
    container.appendChild(fragment);
    const md = convert(container).trim();
    return md.length > 0 ? md : null;
  }, tag);
}

/**
 * 指定タグの新しいブロック（baselineCount+1件目以降）が安定するまで待機
 * baselineCount: 送信前に存在していた完全なブロック数
 */
async function waitForNewOutput(
  page: Page,
  baselineCount: number,
  tag: string,
  maxWaitMs = 600_000,
  minChars = 500,
): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  let bestText = '';
  let stableCount = 0;
  let iteration = 0;

  while (Date.now() < deadline) {
    iteration++;
    await page.waitForTimeout(3000);

    try {
      // タグ数カウントは innerText で十分（[TAG] は plain text として残る）
      const bodyText = await page.innerText('body').catch(() => '');
      const totalBlocks = countTaggedBlocks(bodyText, tag);

      // まだ新しいブロックが完成していない
      if (totalBlocks <= baselineCount) continue;

      // コンテンツ抽出は DOM ベース（Markdown 見出し・コードフェンスを保持）
      const content = await extractLastTaggedBlockMarkdown(page, tag);
      if (!content || content.length < minChars) continue;

      if (content === bestText) {
        stableCount++;
        if (stableCount >= 2) {
          console.log(`✓ 出力確定 [${tag}]: ${content.length}文字`);
          return content;
        }
      } else {
        bestText = content;
        stableCount = 0;
        if (iteration % 5 === 0) console.log(`  生成中 [${tag}]: ${content.length}文字`);
      }
    } catch {
      // ページ遷移等の一時的エラーは無視
    }
  }

  if (bestText.length >= minChars) {
    console.warn(`⚠ タイムアウト - ベスト出力を採用: ${bestText.length}文字`);
    return bestText;
  }
  throw new Error(
    `タイムアウト: [${tag}] の新規ブロックが${maxWaitMs / 1000}秒以内に得られませんでした`,
  );
}

// ─── パイプライン構築 ─────────────────────────────────────────────────────────

async function buildSitemapCsv(): Promise<string> {
  const files = await fs.readdir(BLOG_DIR).catch(() => [] as string[]);
  const rows: string[] = ['URL,KW,title,description'];
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;

  for (const file of files.filter((f) => f.endsWith('.mdx'))) {
    const content = await fs.readFile(path.join(BLOG_DIR, file), 'utf-8').catch(() => '');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];
    const titleMatch = fm.match(/^title:\s*"?(.+?)"?\s*$/m);
    if (!titleMatch) continue;
    const slug = file.replace('.mdx', '');
    const url = `/ai-seo-blog/blog/${slug}/`;
    const kw = fm.match(/^keyword:\s*"?(.+?)"?\s*$/m)?.[1] ?? '';
    const title = titleMatch[1];
    const desc = fm.match(/^description:\s*"?(.+?)"?\s*$/m)?.[1] ?? '#N/A';
    rows.push(`${escape(url)},${escape(kw)},${escape(title)},${escape(desc)}`);
  }

  return rows.join('\n');
}

async function buildPipelinePrompts(kw: Keyword, sitemapCsv: string): Promise<string[]> {
  const tagStr = kw.tags.join('、');
  return Promise.all(
    STEP_FILES.map(async (file) => {
      const text = await fs.readFile(path.join(PROMPT_DIR, file), 'utf-8');
      return text
        .replace(/\{\{keyword\}\}/g, kw.keyword)
        .replace(/\{\{tags\}\}/g, tagStr)
        .replace(/\{\{target\}\}/g, kw.target)
        .replace(/\{\{sitemap_csv\}\}/g, sitemapCsv);
    }),
  );
}

// ─── 出力パース・MDX生成 ──────────────────────────────────────────────────────

function parseArticleOutput(
  inner: string,
  fullBody: string,
): { title: string; body: string; description: string } {
  // 残留タグを除去（Claudeがネストして出力した場合に対応）
  let cleaned = inner
    .replace(/\[\s*\/?ARTICLE_DRAFT\s*\]/gi, '')
    .replace(/\[\s*\/?SEO_RESEARCH_REPORT\s*\]/gi, '')
    .trim();

  // 記事タイプ宣言行を除去（例: 【記事タイプ】：一般記事）
  cleaned = cleaned.replace(/^【記事タイプ】：[^\n]+\n?/m, '').trim();

  // DOM ベース抽出で Markdown の # 見出しが保持される
  const mdHeading = cleaned.match(/^#\s+(.+)/m);
  // フォールバック: #が付かない場合は最初の行をタイトルとして使用
  const firstLine = cleaned.match(/^(.+)/m);

  const title = mdHeading
    ? mdHeading[1].trim()
    : firstLine
      ? firstLine[1].replace(/^#+\s*/, '').trim()
      : 'タイトル未取得';

  // meta_description は [ARTICLE_DRAFT] タグ外に出力されるため fullBody から取得
  const descMatches = [...fullBody.matchAll(/meta_description:\s*(.+)/gi)];
  const description =
    descMatches.length > 0 ? descMatches[descMatches.length - 1][1].trim() : '';

  // タイトル行と meta_description 行を除去してボディを構築
  const bodyWithoutTitle = mdHeading
    ? cleaned.replace(/^#\s+.+\n?/m, '')
    : cleaned.replace(/^.+\n?/m, ''); // レンダリング済みテキストの場合は最初の行を除去

  const body = bodyWithoutTitle
    .replace(/meta_description:.+$/im, '')
    .trim();

  return { title, body, description };
}

function buildMdx(
  kw: Keyword,
  slug: string,
  title: string,
  body: string,
  description: string,
): string {
  const today = new Date().toISOString().split('T')[0];
  return `---
title: "${title.replace(/"/g, '\\"')}"
description: "${description.replace(/"/g, '\\"')}"
pubDate: ${today}
keyword: "${kw.keyword}"
tags: ${JSON.stringify(kw.tags)}
ogImage: /ai-seo-blog/og/${slug}.png
draft: false
---

${body}
`;
}

// ─── メイン ───────────────────────────────────────────────────────────────────

async function main() {
  const kwPath = path.join(ROOT, 'data', 'keywords', 'keywords.json');
  const keywords: Keyword[] = JSON.parse(await fs.readFile(kwPath, 'utf-8'));
  const target = keywords.find((k) => !k.generated);

  if (!target) {
    console.log('生成対象のキーワードがありません（すべて generated: true）');
    return;
  }

  console.log(`\n記事生成開始: "${target.keyword}"`);

  const sitemapCsv = await buildSitemapCsv();
  console.log(`✓ サイトマップCSV: ${sitemapCsv.split('\n').length - 1}件`);

  const prompts = await buildPipelinePrompts(target, sitemapCsv);

  let browser: Browser | null = null;
  let finalTaggedContent = '';
  let finalFullBody = '';

  try {
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.CHROME_PATH,
    ].filter(Boolean) as string[];

    const executablePath = chromePaths.find((p) => {
      try {
        return require('fs').existsSync(p);
      } catch {
        return false;
      }
    });

    browser = await chromium.launch({
      headless: false,
      executablePath,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await buildContext(browser);
    const page = await context.newPage();

    console.log('Claude.ai に接続中...');
    await page.goto(CLAUDE_NEW_CHAT, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForInputBox(page, 30_000);
    console.log('✓ Claude.ai ログイン確認済み');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);

    // 5ステップパイプライン実行（同一会話内でコンテキストが引き継がれる）
    for (let i = 0; i < prompts.length; i++) {
      const tag = STEP_TAGS[i];
      console.log(`\n[Step ${i + 1}/5] ${STEP_NAMES[i]}開始...`);

      // 送信前のブロック数を記録（新しいブロックの出現を正確に検知するため）
      const bodyText = await page.innerText('body').catch(() => '');
      const baselineCount = countTaggedBlocks(bodyText, tag);

      await submitPrompt(page, prompts[i]);

      const mins = STEP_TIMEOUTS[i] / 60_000;
      console.log(`  ${STEP_NAMES[i]}中（最大${mins}分待機）...`);
      const stepOutput = await waitForNewOutput(page, baselineCount, tag, STEP_TIMEOUTS[i], 500);
      console.log(`✓ Step ${i + 1} 完了: ${stepOutput.length}文字`);

      if (i === prompts.length - 1) {
        finalTaggedContent = stepOutput;
        finalFullBody = await page.innerText('body').catch(() => '');
      }

      if (i < prompts.length - 1) {
        await page.waitForTimeout(3000);
      }
    }

    await context.close();
  } finally {
    if (browser) await browser.close();
  }

  const { title, body, description } = parseArticleOutput(finalTaggedContent, finalFullBody);
  console.log(`\n✓ タイトル取得: ${title}`);

  await fs.mkdir(BLOG_DIR, { recursive: true });
  const baseSlug = target.keyword
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/[^\w-]/g, '')
    .replace(/-+$/g, '');
  const today = new Date().toISOString().split('T')[0];
  const slug = baseSlug.length >= 3 ? baseSlug : `post-${today}`;
  const mdxPath = path.join(BLOG_DIR, `${slug}.mdx`);
  await fs.writeFile(mdxPath, buildMdx(target, slug, title, body, description), 'utf-8');
  console.log(`✓ MDX保存: src/content/blog/${slug}.mdx`);

  target.generated = true;
  await fs.writeFile(kwPath, JSON.stringify(keywords, null, 2), 'utf-8');

  console.log('\n記事生成完了');
}

main().catch((err) => {
  console.error('エラー:', err.message);
  process.exit(1);
});
