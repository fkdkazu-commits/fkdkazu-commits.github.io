/**
 * 記事自動生成スクリプト
 * キーワードリストからClaude APIで記事を生成しMDXとして保存する
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

interface Keyword {
  keyword: string;
  intent: string;
  target: string;
  tags: string[];
}

async function loadKeywords(): Promise<Keyword[]> {
  const file = path.join(ROOT, 'data', 'keywords', 'keywords.json');
  const raw = await fs.readFile(file, 'utf-8');
  return JSON.parse(raw);
}

async function generateArticle(kw: Keyword): Promise<string> {
  const systemPrompt = `あなたはSEOの専門家ライターです。
以下のルールで記事を生成してください。
- 日本語で書く
- SEOを意識した見出し構成（H2/H3）
- 読者に価値ある情報を提供する
- 文字数は2000〜3000字程度
- FAQセクションを末尾に追加する
- meta descriptionも生成する（120字以内）`;

  const userPrompt = `以下の情報でSEO記事を生成してください。

キーワード: ${kw.keyword}
検索意図: ${kw.intent}
ターゲット読者: ${kw.target}

出力形式（JSON）:
{
  "title": "記事タイトル",
  "description": "meta description（120字以内）",
  "body": "記事本文（markdown形式）",
  "faq": [{"q": "質問", "a": "回答"}]
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON形式の出力が得られませんでした');
  return jsonMatch[0];
}

function buildMdx(kw: Keyword, article: { title: string; description: string; body: string; faq: { q: string; a: string }[] }): string {
  const now = new Date().toISOString().split('T')[0];
  const slug = kw.keyword.replace(/\s+/g, '-').toLowerCase();

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: article.faq.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };

  const faqMd = article.faq
    .map(({ q, a }) => `### ${q}\n\n${a}`)
    .join('\n\n');

  return `---
title: "${article.title}"
description: "${article.description}"
pubDate: ${now}
keyword: "${kw.keyword}"
tags: ${JSON.stringify(kw.tags)}
draft: false
---

${article.body}

## よくある質問

${faqMd}

<script type="application/ld+json">
${JSON.stringify(faqSchema, null, 2)}
</script>
`;
}

async function saveArticle(slug: string, content: string): Promise<string> {
  const dir = path.join(ROOT, 'src', 'content', 'blog');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}.mdx`);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function main() {
  const keywords = await loadKeywords();

  // 未生成のキーワードを1件取得（本番では複数処理可能）
  const target = keywords.find((kw) => !kw['generated']);
  if (!target) {
    console.log('生成対象のキーワードがありません');
    return;
  }

  console.log(`記事生成開始: ${target.keyword}`);
  const raw = await generateArticle(target);
  const article = JSON.parse(raw);

  const slug = target.keyword.replace(/\s+/g, '-').toLowerCase();
  const mdx = buildMdx(target, article);
  const filePath = await saveArticle(slug, mdx);

  console.log(`記事生成完了: ${filePath}`);

  // generated フラグを更新
  target['generated'] = true;
  const file = path.join(ROOT, 'data', 'keywords', 'keywords.json');
  await fs.writeFile(file, JSON.stringify(keywords, null, 2), 'utf-8');
}

main().catch(console.error);
