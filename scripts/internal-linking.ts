/**
 * 内部リンク自動追加スクリプト
 * 新規記事と既存記事の関連性をClaudeで分析し、内部リンクを挿入する
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(ROOT, 'src', 'content', 'blog');

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

interface ArticleSummary {
  slug: string;
  title: string;
  keyword: string;
  description: string;
}

function extractFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...vals] = line.split(':');
    if (key && vals.length) result[key.trim()] = vals.join(':').trim().replace(/^"|"$/g, '');
  }
  return result;
}

async function loadAllArticles(): Promise<ArticleSummary[]> {
  const files = await fs.readdir(BLOG_DIR);
  const articles: ArticleSummary[] = [];

  for (const file of files.filter((f) => f.endsWith('.mdx'))) {
    const content = await fs.readFile(path.join(BLOG_DIR, file), 'utf-8');
    const fm = extractFrontmatter(content);
    articles.push({
      slug: file.replace('.mdx', ''),
      title: fm.title || '',
      keyword: fm.keyword || '',
      description: fm.description || '',
    });
  }
  return articles;
}

async function findRelatedArticles(target: ArticleSummary, all: ArticleSummary[]): Promise<ArticleSummary[]> {
  const others = all.filter((a) => a.slug !== target.slug);
  if (others.length === 0) return [];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `以下のターゲット記事に内部リンクを貼るべき関連記事を選んでください。
最大3件選び、slugのみをJSON配列で返してください。

ターゲット記事:
タイトル: ${target.title}
キーワード: ${target.keyword}

候補記事:
${others.map((a) => `- slug: ${a.slug}, タイトル: ${a.title}, キーワード: ${a.keyword}`).join('\n')}

出力例: ["slug-a", "slug-b"]`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  const slugs: string[] = JSON.parse(match[0]);
  return others.filter((a) => slugs.includes(a.slug));
}

async function insertLinks(targetSlug: string, related: ArticleSummary[]): Promise<void> {
  const filePath = path.join(BLOG_DIR, `${targetSlug}.mdx`);
  let content = await fs.readFile(filePath, 'utf-8');

  const linkSection = `\n\n## 関連記事\n\n${related
    .map((a) => `- [${a.title}](/blog/${a.slug}/)`)
    .join('\n')}\n`;

  // FAQ直前か末尾に挿入（重複防止）
  if (content.includes('## 関連記事')) return;

  if (content.includes('## よくある質問')) {
    content = content.replace('## よくある質問', `${linkSection}\n## よくある質問`);
  } else {
    content += linkSection;
  }

  await fs.writeFile(filePath, content, 'utf-8');
  console.log(`内部リンク追加: ${targetSlug} → ${related.map((a) => a.slug).join(', ')}`);
}

async function main() {
  const articles = await loadAllArticles();
  if (articles.length < 2) {
    console.log('記事が2件未満のためスキップ');
    return;
  }

  // 最新記事（更新日時が最新のファイル）を対象にする
  const files = await fs.readdir(BLOG_DIR);
  const sorted = await Promise.all(
    files.filter((f) => f.endsWith('.mdx')).map(async (f) => ({
      f,
      mtime: (await fs.stat(path.join(BLOG_DIR, f))).mtime,
    }))
  );
  sorted.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const targetSlug = sorted[0].f.replace('.mdx', '');
  const target = articles.find((a) => a.slug === targetSlug);
  if (!target) return;

  console.log(`内部リンク解析対象: ${target.title}`);
  const related = await findRelatedArticles(target, articles);
  if (related.length === 0) {
    console.log('関連記事なし');
    return;
  }

  await insertLinks(targetSlug, related);
}

main().catch(console.error);
