/**
 * Claude.ai セッションCookie取得ツール
 *
 * ブラウザを起動してClaude.aiを開き、ログイン後にCookieをエクスポートする
 * GitHub Secrets への登録に使う
 *
 * 使い方（初回セットアップ時に1回だけ実行）:
 *   npx tsx scripts/export-cookies.ts
 */
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function waitForEnter(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  console.log('\n=== Claude.ai Cookie エクスポートツール ===\n');
  console.log('ブラウザを起動してClaude.aiを開きます...\n');

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // Bot検知回避: webdriverフラグを隠す
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  await page.goto('https://claude.ai', { waitUntil: 'domcontentloaded' });

  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  操作手順                                      │');
  console.log('│  1. 開いたブラウザでClaude.aiにログインする    │');
  console.log('│  2. ログイン完了後、チャット画面が表示されたら  │');
  console.log('│     このターミナルで Enter を押す              │');
  console.log('└──────────────────────────────────────────────┘\n');

  await waitForEnter('ログイン完了後に Enter を押してください...');

  // ログイン確認
  const inputExists = await page.$('div[contenteditable="true"]').catch(() => null);
  if (!inputExists) {
    console.warn('\n⚠ Claude.aiのチャット画面が検出されませんでした。');
    console.warn('  ログインが完了しているか確認してから再実行してください。\n');
    await browser.close();
    return;
  }

  // Cookie取得
  const cookies = await context.cookies('https://claude.ai');

  if (cookies.length === 0) {
    console.error('\n✗ Cookieが取得できませんでした。ログイン状態を確認してください。\n');
    await browser.close();
    return;
  }

  await browser.close();

  // ファイルに保存（gitignore済み）
  const outPath = path.join(ROOT, 'claude-cookies.json');
  await fs.writeFile(outPath, JSON.stringify(cookies, null, 2), 'utf-8');

  const jsonOneLine = JSON.stringify(cookies);

  console.log(`\n✓ Cookie取得完了: ${cookies.length}件`);
  console.log(`✓ ファイル保存: claude-cookies.json（.gitignoreで除外済み）\n`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('【GitHub Secretsへの登録手順】\n');
  console.log('1. 以下のURLを開く:');
  console.log('   https://github.com/fkdkazu-commits/fkdkazu-commits.github.io/settings/secrets/actions\n');
  console.log('2. "New repository secret" をクリック\n');
  console.log('3. 以下を入力:');
  console.log('   Name:  CLAUDE_COOKIES');
  console.log('   Value: claude-cookies.json の内容をそのまま貼り付け\n');
  console.log('4. "Add secret" で保存\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n登録後、GitHub Actions → "Daily Article Generation" → Run workflow で動作確認してください。');
  console.log('\n⚠ claude-cookies.json は絶対にGitHubにコミットしないでください。\n');
}

main().catch((err) => {
  console.error('エラー:', err.message);
  process.exit(1);
});
