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

  // プロファイルの SingletonLock / LOCK ファイルを削除（前回クラッシュ時のロック解除）
  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'Default/LOCK']) {
    await fs.unlink(path.join(PROFILE_DIR, lockFile)).catch(() => {});
  }

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
  await page.waitForTimeout(2000);
  console.log(`✓ プロンプト送信後 URL: ${page.url()}`);
  console.log(`  body文字数: ${await page.evaluate(() => document.body?.textContent?.length ?? 0).catch(() => 0)}`);
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
 * 指定タグの closing tag が出現するまで page.waitForFunction で待機し、
 * 出現後に extractLastTaggedBlockMarkdown で Markdown 抽出する。
 * innerText / CSS セレクターに依存しない最もシンプルで確実な実装。
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
  const closingTag = `[/${tag}]`;
  console.log(`  closing tag 待機中: "${closingTag}"`);

  // ─── 主戦略: page.waitForFunction でブラウザ内部から closing tag を検知 ───
  let tagFound = false;
  try {
    await page.waitForFunction(
      ({ closing, baseline }: { closing: string; baseline: number }) => {
        const text = document.body?.textContent ?? '';
        // baseline より多くの closing tag が存在するか確認
        let count = 0;
        let pos = 0;
        while ((pos = text.indexOf(closing, pos)) !== -1) { count++; pos++; }
        return count > baseline;
      },
      { closing: closingTag, baseline: baselineCount },
      { timeout: maxWaitMs, polling: 2000 },
    );
    tagFound = true;
    console.log(`  closing tag 検知！Markdown 抽出中...`);
  } catch {
    console.warn(`⚠ waitForFunction タイムアウト（${maxWaitMs / 1000}秒）- フォールバック処理`);
  }

  // tag が見つかった（または後続フォールバック）の場合: 安定するまで最大 30 秒待機して抽出
  const shouldExtract = tagFound || await page.evaluate(
    (t: string) => (document.body?.textContent ?? '').includes(`[/${t}]`), tag
  ).catch(() => false);

  if (shouldExtract) {
    if (!tagFound) console.warn(`⚠ タイムアウト（${maxWaitMs / 1000}秒）後 DOM 直接確認 → closing tag 発見`);

    // ページ最上部にスクロール（opening tag が DOM から消えている場合の対策）
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(1000);

    let bestContent = '';
    let stableCount = 0;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(3000);

      // 1. DOM Range API で Markdown 抽出
      let content = await extractLastTaggedBlockMarkdown(page, tag).catch(() => null);

      // 2. opening tag が見つからなくても closing tag 前の内容を平文抽出
      if (!content || content.length < minChars) {
        content = await page.evaluate((tagName: string) => {
          const text = document.body?.textContent ?? '';
          const openTag = `[${tagName}]`;
          const closeTag = `[/${tagName}]`;
          const closeIdx = text.lastIndexOf(closeTag);
          if (closeIdx === -1) return null;
          const openIdx = text.lastIndexOf(openTag);
          const startIdx = (openIdx !== -1 && openIdx < closeIdx)
            ? openIdx + openTag.length
            : Math.max(0, closeIdx - 30000); // opening tag なしでも最大30000文字分遡る
          return text.slice(startIdx, closeIdx).trim() || null;
        }, tag).catch(() => null);
        if (content) console.log(`  平文抽出: ${content.length}文字`);
      }

      if (content && content.length >= minChars) {
        if (content === bestContent) {
          stableCount++;
          if (stableCount >= 2) {
            console.log(`✓ 出力確定 [${tag}]: ${content.length}文字`);
            return content;
          }
        } else {
          bestContent = content;
          stableCount = 0;
          console.log(`  抽出中 [${tag}]: ${content.length}文字`);
        }
      } else {
        console.log(`  抽出待機中 (${i + 1}/10): content=${content?.length ?? 0}文字`);
      }
    }
    if (bestContent.length >= minChars) {
      console.log(`✓ 出力確定（安定待ち省略）[${tag}]: ${bestContent.length}文字`);
      return bestContent;
    }
    if (bestContent.length > 0) {
      console.warn(`⚠ 短い出力（${bestContent.length}文字）を採用して続行`);
      return bestContent;
    }
  } else {
    console.warn(`⚠ タイムアウト（${maxWaitMs / 1000}秒）- closing tag が見つかりませんでした`);
  }

  throw new Error(
    `タイムアウト: [${tag}] の出力が${maxWaitMs / 1000}秒以内に得られませんでした`,
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
      const baselineSnapshot = await snapshotAssistantCandidates(page);

      await submitPrompt(page, prompts[i]);

      // プロンプト送信後に baseline を取り直す（プロンプト本文にタグが含まれる場合の false positive 対策）
      await page.waitForTimeout(1000);
      const baselineCount = await page.evaluate((tagName: string) => {
        const closeTag = `[/${tagName}]`;
        const text = document.body?.textContent ?? '';
        let count = 0, pos = 0;
        while ((pos = text.indexOf(closeTag, pos)) !== -1) { count++; pos++; }
        return count;
      }, tag).catch(() => 0);
      const bodyText = ''; // innerText は使用しない（取得失敗のため）
      console.log(`  baseline [/${tag}] count: ${baselineCount}`);

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
        const recoverySnapshot = await snapshotAssistantCandidates(page);
        await submitPrompt(page, buildRecoveryPrompt());
        await page.waitForTimeout(1000);
        const recoveryBaselineCount = await page.evaluate((tagName: string) => {
          const closeTag = `[/${tagName}]`;
          const text = document.body?.textContent ?? '';
          let count = 0, pos = 0;
          while ((pos = text.indexOf(closeTag, pos)) !== -1) { count++; pos++; }
          return count;
        }, tag).catch(() => 0);
        stepOutput = await waitForNewOutput(
          page,
          recoveryBaselineCount,
          recoverySnapshot,
          '',
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
