/**
 * Playwright経由でClaude.ai Webを操作してSEO記事を自動生成する
 * 5ステップパイプライン: リサーチ→記事生成→ファクトチェック→品質向上→内部リンク
 *
 * APIキー不要 - Claude Proサブスクリプションのセッションを永続プロファイルで管理
 * CLAUDE_COOKIES 不要 - C:\Users\fkdka\.claude-profiles\ai-seo-blog に自動保存・再利用
 *
 * 初回実行時はブラウザが起動するのでClaude.aiにログインしてください（以降は自動）
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(ROOT, 'src', 'content', 'blog');
const PROMPT_DIR = path.join(ROOT, 'data', 'prompts');

// ブラウザプロファイル永続化ディレクトリ（セッションがここに保存・再利用される）
const PROFILE_DIR = 'C:\\Users\\fkdka\\.claude-profiles\\ai-seo-blog';

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

// アシスタント出力を探すセレクター（Claude UI変更に対応する多候補）
const OUTPUT_SELECTORS = [
  '[data-message-role="assistant"]',
  '[data-testid*="assistant"]',
  '[data-testid*="message"] .prose',
  '.font-claude-message',
  'div[class*="font-claude"]',
  'div[class*="message-content"]',
  'div[class*="AssistantMessage"]',
  'div[class*="assistant-message"]',
  'main article',
  'main .prose',
  'div.prose',
  'main div[class*="prose"]',
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
  600_000,   // Step 1: リサーチ        10分
  1_800_000, // Step 2: 記事生成        30分（8000字以上）
  1_200_000, // Step 3: ファクトチェック 20分
  900_000,   // Step 4: 品質向上        15分
  600_000,   // Step 5: 内部リンク      10分
];
const STEP_FILES = [
  'step1-research.txt',
  'step2-article.txt',
  'step3-factcheck.txt',
  'step4-quality.txt',
  'step5-links.txt',
];

// 質問返し検知マーカー
const INTERRUPT_MARKERS = [
  'どこから着手しましょうか',
  'どこから始めましょうか',
  'どう進めましょうか',
  '要件定義ですね',
  'おはようございます',
  'こんばんは',
];

interface Keyword {
  keyword: string;
  intent: string;
  target: string;
  tags: string[];
  generated?: boolean;
}

// ─── セッション管理（永続プロファイル方式） ────────────────────────────────────

async function buildContext(): Promise<BrowserContext> {
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
  });

  return context;
}

async function waitForInputBox(page: Page, timeoutMs = 300_000): Promise<void> {
  // URLが claude.ai のチャット画面になるまでポーリングで待機
  //（ログインページ・OAuth画面ではなく、実際の入力ボックスが現れる画面を待つ）
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    // claude.ai ドメインかつ /login や /auth ではない → ログイン済みの可能性
    if (url.startsWith('https://claude.ai') && !/\/(login|auth|signup|pricing)/.test(url)) {
      for (const selector of INPUT_SELECTORS) {
        const el = await page.$(selector).catch(() => null);
        if (el) return;
      }
    }
    await page.waitForTimeout(2000);
  }
  const url = page.url();
  const title = await page.title().catch(() => '取得失敗');
  const bodySnippet = await page.innerText('body').catch(() => '').then((t) => t.slice(0, 300));
  console.error(`現在のURL: ${url}`);
  console.error(`ページタイトル: ${title}`);
  console.error(`ページ内容（先頭300字）: ${bodySnippet}`);
  throw new Error('Claude.ai の入力ボックスが見つかりません。ブラウザでログインしてください。');
}

async function submitPrompt(page: Page, promptText: string): Promise<void> {
  let inputBox = null;
  for (const selector of INPUT_SELECTORS) {
    inputBox = await page.$(selector);
    if (inputBox) break;
  }
  if (!inputBox) throw new Error('入力ボックスが見つかりません');

  // 一度クリックしてフォーカスを当てる
  await inputBox.click();
  await page.waitForTimeout(500);
  await inputBox.fill(promptText);
  await page.waitForTimeout(500);
  console.log(`✓ プロンプト入力 (${promptText.length}文字)`);
  console.log(`  URL: ${page.url()}`);

  let sent = false;
  for (const selector of SUBMIT_SELECTORS) {
    const btn = await page.$(selector);
    if (btn) {
      await btn.click();
      sent = true;
      console.log(`  送信ボタン: ${selector}`);
      break;
    }
  }
  if (!sent) {
    await page.keyboard.press('Control+Enter');
    console.log('  送信: Ctrl+Enter');
  }
  await page.waitForTimeout(3000);
  const urlAfter = page.url();
  const bodyLen = (await page.innerText('body').catch(() => '')).length;
  console.log(`✓ プロンプト送信後 URL: ${urlAfter}`);
  console.log(`  body文字数: ${bodyLen}`);

  // デバッグ用スクリーンショット（送信直後の画面状態を保存）
  const screenshotPath = path.join(ROOT, `debug-after-submit.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  console.log(`  スクリーンショット保存: ${screenshotPath}`);
}

// ─── 出力検出 ─────────────────────────────────────────────────────────────────

function countTaggedBlocks(text: string, tag: string): number {
  // 全角括弧・エスケープ括弧を正規化してからカウント
  const normalized = text
    .replace(/［/g, '[').replace(/］/g, ']')
    .replace(/【/g, '[').replace(/】/g, ']')
    .replace(/\\\[/g, '[').replace(/\\\]/g, ']');
  const re = new RegExp(`\\[\\s*${tag}\\s*\\]([\\s\\S]*?)\\[\\s*/\\s*${tag}\\s*\\]`, 'gi');
  return [...normalized.matchAll(re)].length;
}

function isConversationalInterrupt(text: string, tag: string): boolean {
  if (!text.trim()) return true;
  const upper = text.toUpperCase();
  if (upper.includes(`[${tag}]`) || upper.includes('[SEO_RESEARCH_REPORT]')) return false;
  return INTERRUPT_MARKERS.some((m) => text.includes(m));
}

function buildRecoveryPrompt(): string {
  return (
    '前の依頼は相談ではなく実行指示です。\n' +
    '質問や確認はせず、このまま処理を最後まで実行してください。\n' +
    '前の指示で要求された出力フォーマットのみを返してください。'
  );
}

async function snapshotAssistantCandidates(page: Page): Promise<Set<string>> {
  const snapshot = new Set<string>();
  for (const selector of OUTPUT_SELECTORS) {
    try {
      const elements = await page.$$(selector);
      for (const el of elements) {
        const text = (await el.innerText()).trim();
        if (text.length >= 40) snapshot.add(text);
      }
    } catch {
      continue;
    }
  }
  return snapshot;
}

/**
 * DOM Range APIを使い [TAG]...[/TAG] の最後のブロックをMarkdown形式で抽出。
 * innerText では失われる ## 見出しやコードフェンスを保持する。
 */
async function extractLastTaggedBlockMarkdown(page: Page, tag: string): Promise<string | null> {
  return await page.evaluate((tagName: string) => {
    const openTag = `[${tagName}]`;
    const closeTag = `[/${tagName}]`;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) textNodes.push(n as Text);

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

    let fragment: DocumentFragment;
    try {
      const range = document.createRange();
      range.setStart(openNode, openOffset);
      range.setEnd(closeNode, closeOffset);
      fragment = range.cloneContents();
    } catch {
      return null;
    }

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
 * 指定タグの新しいブロックが安定するまで待機
 * seo-article-pipeline の多層フォールバック戦略を移植:
 *   1. タグ付きブロック（DOM Range API）
 *   2. セレクターベース候補（安定性チェック）
 *   3. タイムアウト後 body 再解析
 *   4. ベスト出力フォールバック
 */
async function waitForNewOutput(
  page: Page,
  baselineCount: number,
  baselineSnapshot: Set<string>,
  baselineBodyText: string,
  promptText: string,
  tag: string,
  maxWaitMs = 600_000,
  minChars = 500,
): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  let bestTaggedText = '';
  let bestSelectorText = '';
  let stableCount = 0;
  let prevBestLen = 0;
  let iteration = 0;
  let lastBodyText = '';

  while (Date.now() < deadline) {
    iteration++;
    await page.waitForTimeout(3000);

    try {
      const bodyText = await page.innerText('body').catch(() => '');
      lastBodyText = bodyText;
      const bodyGrowthNow = bodyText.length - baselineBodyText.length;

      // 30秒おきに診断ログを出力
      if (iteration % 10 === 1) {
        console.log(`  [診断] URL: ${page.url()}`);
        console.log(`  [診断] body: ${bodyText.length}文字 (差分: ${bodyGrowthNow > 0 ? '+' : ''}${bodyGrowthNow})`);
        const titleEl = await page.$('title').catch(() => null);
        const title = titleEl ? await titleEl.innerText().catch(() => '') : '';
        if (title) console.log(`  [診断] タイトル: ${title}`);
      }

      // 1. タグ付きブロック優先（DOM Range API でMarkdown抽出）
      const totalBlocks = countTaggedBlocks(bodyText, tag);
      if (totalBlocks > baselineCount) {
        const content = await extractLastTaggedBlockMarkdown(page, tag);
        if (content && content.length >= minChars) {
          if (content === bestTaggedText) {
            stableCount++;
            if (stableCount >= 2) {
              console.log(`✓ 出力確定 [${tag}]: ${content.length}文字`);
              return content;
            }
          } else {
            bestTaggedText = content;
            stableCount = 0;
            if (iteration % 5 === 0) console.log(`  生成中 [${tag}]: ${content.length}文字`);
          }
          continue;
        }
      }

      // 2. セレクターベース検索（タグ検出待ち・UI変更対応）
      const candidates: string[] = [];
      for (const selector of OUTPUT_SELECTORS) {
        try {
          const elements = await page.$$(selector);
          for (const el of elements) {
            const text = (await el.innerText()).trim();
            if (text.length >= 100 && !baselineSnapshot.has(text)) {
              candidates.push(text);
            }
          }
        } catch {
          continue;
        }
      }

      if (candidates.length > 0) {
        const current = candidates.reduce((a, b) => (a.length > b.length ? a : b));
        if (current.length > bestSelectorText.length) {
          bestSelectorText = current;
          stableCount = 0;
        } else if (current.length === bestSelectorText.length && bestSelectorText.length >= minChars) {
          stableCount++;
          if (stableCount >= 2) {
            console.log(`✓ 出力確定（セレクター）: ${current.length}文字`);
            return current;
          }
        }
        if (iteration % 10 === 0) console.log(`  待機中 [${tag}]: ${current.length}文字`);
      }

      // 3. body全体差分監視（セレクター非対応のUI変更に対する最終フォールバック）
      if (bodyGrowthNow > 300) {
        // ベースライン末尾100字と重複させて新規テキストを取得
        const overlapStart = Math.max(0, baselineBodyText.length - 100);
        const tail = bodyText.slice(overlapStart).trim();
        if (tail.length > bestSelectorText.length) {
          if (tail.length === prevBestLen) {
            stableCount++;
            if (stableCount >= 2 && tail.length >= minChars) {
              console.log(`✓ 出力確定（body差分）: ${tail.length}文字 (増加: +${bodyGrowthNow}文字)`);
              return tail;
            }
          } else {
            prevBestLen = tail.length;
            stableCount = 0;
            if (iteration % 5 === 0) console.log(`  body成長中: +${bodyGrowthNow}文字`);
          }
          bestSelectorText = tail;
        }
      }
    } catch {
      // ページ遷移等の一時的エラーは無視
    }
  }

  // ─── フォールバック: タイムアウト後も出力があれば採用 ───
  console.warn(`⚠ タイムアウト（${maxWaitMs / 1000}秒）- フォールバック処理`);

  // タイムアウト後 body 再解析でタグ付きブロックを最終確認
  if (lastBodyText) {
    const totalBlocks = countTaggedBlocks(lastBodyText, tag);
    if (totalBlocks > baselineCount) {
      const content = await extractLastTaggedBlockMarkdown(page, tag).catch(() => null);
      if (content && content.length >= minChars) {
        console.warn(`⚠ タイムアウト後 body 再解析でタグ付きブロックを採用: ${content.length}文字`);
        return content;
      }
    }
  }

  // タグなしでもベスト出力を採用
  const best = bestTaggedText.length > bestSelectorText.length ? bestTaggedText : bestSelectorText;
  if (best.length >= minChars) {
    console.warn(`⚠ ベスト出力を採用: ${best.length}文字`);
    return best;
  }

  // 最終救済: minChars の1/3 以上あれば次工程へ渡す
  const minPartial = Math.max(200, Math.floor(minChars / 3));
  if (best.length >= minPartial) {
    console.warn(`⚠ 部分出力（${best.length}文字）を採用して続行`);
    return best;
  }

  throw new Error(
    `タイムアウト: [${tag}] の出力が${maxWaitMs / 1000}秒以内に得られませんでした（最大: ${best.length}文字）`,
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
  let cleaned = inner
    .replace(/\[\s*\/?ARTICLE_DRAFT\s*\]/gi, '')
    .replace(/\[\s*\/?SEO_RESEARCH_REPORT\s*\]/gi, '')
    .trim();

  cleaned = cleaned.replace(/^【記事タイプ】：[^\n]+\n?/m, '').trim();

  const mdHeading = cleaned.match(/^#\s+(.+)/m);
  const firstLine = cleaned.match(/^(.+)/m);

  const title = mdHeading
    ? mdHeading[1].trim()
    : firstLine
      ? firstLine[1].replace(/^#+\s*/, '').trim()
      : 'タイトル未取得';

  const descMatches = [...fullBody.matchAll(/meta_description:\s*(.+)/gi)];
  const description =
    descMatches.length > 0 ? descMatches[descMatches.length - 1][1].trim() : '';

  const bodyWithoutTitle = mdHeading
    ? cleaned.replace(/^#\s+.+\n?/m, '')
    : cleaned.replace(/^.+\n?/m, '');

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
  console.log(`プロファイルディレクトリ: ${PROFILE_DIR}`);

  const sitemapCsv = await buildSitemapCsv();
  console.log(`✓ サイトマップCSV: ${sitemapCsv.split('\n').length - 1}件`);

  const prompts = await buildPipelinePrompts(target, sitemapCsv);

  let context: BrowserContext | null = null;
  let finalTaggedContent = '';
  let finalFullBody = '';

  try {
    context = await buildContext();
    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    console.log('Claude.ai に接続中...');
    // ログインページへのリダイレクトが発生しても timeout しないよう commit で待機
    await page.goto(CLAUDE_NEW_CHAT, { waitUntil: 'commit', timeout: 120_000 }).catch(() => {});

    // 初回ログイン時は最大10分待機（ログイン→OAuth→コールバック→チャット画面の遷移を含む）
    console.log('ログイン確認中（未ログインの場合はブラウザでログインしてください）...');
    await waitForInputBox(page, 600_000);
    console.log('✓ Claude.ai ログイン確認済み');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);

    // 5ステップパイプライン実行（同一会話でコンテキストを引き継ぐ）
    for (let i = 0; i < prompts.length; i++) {
      const tag = STEP_TAGS[i];
      console.log(`\n[Step ${i + 1}/5] ${STEP_NAMES[i]}開始...`);

      // 送信前スナップショット（既存メッセージとの区別に使用）
      const bodyText = await page.innerText('body').catch(() => '');
      const baselineCount = countTaggedBlocks(bodyText, tag);
      const baselineSnapshot = await snapshotAssistantCandidates(page);

      await submitPrompt(page, prompts[i]);

      const mins = STEP_TIMEOUTS[i] / 60_000;
      console.log(`  ${STEP_NAMES[i]}中（最大${mins}分待機）...`);

      let stepOutput = await waitForNewOutput(
        page,
        baselineCount,
        baselineSnapshot,
        bodyText,
        prompts[i],
        tag,
        STEP_TIMEOUTS[i],
        500,
      );
      console.log(`✓ Step ${i + 1} 完了: ${stepOutput.length}文字`);

      // 質問返し検知 → 自動回復プロンプトを1回送信
      if (isConversationalInterrupt(stepOutput, tag)) {
        console.warn(`⚠ 質問返しを検知。回復プロンプトを送信します...`);
        const recoveryBody = await page.innerText('body').catch(() => '');
        const recoveryBaselineCount = countTaggedBlocks(recoveryBody, tag);
        const recoverySnapshot = await snapshotAssistantCandidates(page);
        await submitPrompt(page, buildRecoveryPrompt());
        stepOutput = await waitForNewOutput(
          page,
          recoveryBaselineCount,
          recoverySnapshot,
          recoveryBody,
          buildRecoveryPrompt(),
          tag,
          STEP_TIMEOUTS[i],
          500,
        );
        console.log(`✓ 回復後 Step ${i + 1}: ${stepOutput.length}文字`);
      }

      if (i === prompts.length - 1) {
        finalTaggedContent = stepOutput;
        finalFullBody = await page.innerText('body').catch(() => '');
      }

      if (i < prompts.length - 1) {
        await page.waitForTimeout(3000);
      }
    }
  } finally {
    if (context) await context.close();
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
