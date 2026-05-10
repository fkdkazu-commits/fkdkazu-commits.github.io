/**
 * 記事公開スクリプト
 * MDXファイルを確認してgit commit・pushまで自動実行する
 *
 * 使い方:
 *   npm run publish -- --slug "seo-対策-初心者"
 */
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(ROOT, 'src', 'content', 'blog');

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      result[args[i].slice(2)] = args[i + 1] ?? '';
      i++;
    }
  }
  return result;
}

function extractTitle(content: string): string {
  const match = content.match(/^title:\s*"(.+?)"/m);
  return match ? match[1] : '記事';
}

async function main() {
  const args = parseArgs();
  const slug = args['slug'];

  if (!slug) {
    // slugが指定されていなければdraft:falseで未公開のものを全部pushする
    console.log('全記事を公開します...');
    execSync('git add src/content/blog/ public/og/ data/', { stdio: 'inherit', cwd: ROOT });
    execSync(`git commit -m "feat: 記事公開 ${new Date().toLocaleDateString('ja-JP')}"`, { stdio: 'inherit', cwd: ROOT });
    execSync('git push', { stdio: 'inherit', cwd: ROOT });
    console.log('✓ GitHub Pages へのデプロイを開始しました（約2分で公開）');
    return;
  }

  const filePath = path.join(BLOG_DIR, `${slug}.mdx`);
  const content = await fs.readFile(filePath, 'utf-8');
  const title = extractTitle(content);

  // draft: true になっていたら false に変更
  if (content.includes('draft: true')) {
    const updated = content.replace('draft: true', 'draft: false');
    await fs.writeFile(filePath, updated, 'utf-8');
    console.log(`✓ draft: false に変更しました`);
  }

  console.log(`公開対象: ${title}`);
  execSync(`git add src/content/blog/${slug}.mdx`, { stdio: 'inherit', cwd: ROOT });
  execSync(`git commit -m "feat: 記事公開「${title}」"`, { stdio: 'inherit', cwd: ROOT });
  execSync('git push', { stdio: 'inherit', cwd: ROOT });

  console.log(`\n✓ プッシュ完了！GitHub Pages に約2分で公開されます`);
  console.log(`  URL: https://fkdkazu-commits.github.io/blog/${slug}/\n`);
}

main().catch(console.error);
