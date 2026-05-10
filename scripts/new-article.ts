/**
 * 新規記事作成スクリプト
 * Claude Pro で生成した内容を貼り付けるためのMDXテンプレートを生成する
 *
 * 使い方:
 *   npm run new -- --keyword "SEO対策 初心者" --tags "SEO,初心者"
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(ROOT, 'src', 'content', 'blog');

function toSlug(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-+/g, '-');
}

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

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function buildTemplate(keyword: string, tags: string[]): string {
  const today = new Date().toISOString().split('T')[0];
  const slug = toSlug(keyword);

  return `---
title: "【ここにタイトルを入力】"
description: "【ここにmeta descriptionを入力（120字以内）】"
pubDate: ${today}
keyword: "${keyword}"
tags: ${JSON.stringify(tags)}
draft: false
---

<!-- ↓ Claude Pro で生成した本文をここに貼り付けてください -->

## はじめに

（本文をここに貼り付け）

## まとめ

（まとめをここに貼り付け）

## よくある質問

### 質問1

回答1

### 質問2

回答2
`;
}

function buildClaudePrompt(keyword: string): string {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Claude Pro に貼り付けるプロンプト（prompts/ にも保存されます）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

以下のキーワードでSEO記事を書いてください。

【キーワード】${keyword}

【要件】
- 文字数: 2,000〜3,000字
- 見出し構成: H2で3〜5個、必要に応じてH3を使う
- 読者に価値ある情報を具体的に書く
- E-E-A-T（経験・専門性・権威性・信頼性）を意識する
- 末尾にFAQセクションを3問追加する

【出力形式】
タイトル（H1）→ 本文（Markdown） → FAQ の順で出力してください。
meta descriptionも最後に1行追加してください（120字以内）。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

async function main() {
  const args = parseArgs();
  let keyword = args['keyword'] || '';
  let tagsInput = args['tags'] || '';

  if (!keyword) {
    keyword = await ask('キーワードを入力してください: ');
  }
  if (!tagsInput) {
    tagsInput = await ask('タグをカンマ区切りで入力してください（例: SEO,初心者）: ');
  }

  const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
  const slug = toSlug(keyword);
  const filePath = path.join(BLOG_DIR, `${slug}.mdx`);
  const promptPath = path.join(ROOT, 'prompts', `${slug}.txt`);

  // MDXテンプレート生成
  await fs.mkdir(BLOG_DIR, { recursive: true });
  await fs.writeFile(filePath, buildTemplate(keyword, tags), 'utf-8');

  // Claudeプロンプト保存
  await fs.mkdir(path.join(ROOT, 'prompts'), { recursive: true });
  await fs.writeFile(promptPath, buildClaudePrompt(keyword), 'utf-8');

  console.log(`\n✓ MDXテンプレート作成: src/content/blog/${slug}.mdx`);
  console.log(`✓ Claudeプロンプト保存: prompts/${slug}.txt`);
  console.log(buildClaudePrompt(keyword));
  console.log(`\n次のステップ:`);
  console.log(`  1. 上のプロンプトを Claude Pro（claude.ai）に貼り付けて記事を生成`);
  console.log(`  2. 生成された内容を src/content/blog/${slug}.mdx に貼り付け`);
  console.log(`  3. git add . && git push でGitHub Pagesへ自動デプロイ\n`);
}

main().catch(console.error);
