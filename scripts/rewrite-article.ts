/**
 * AIリライトスクリプト
 * analyze-gsc.tsが出力したrewrite-candidates.jsonを読み込み、
 * Claudeで記事をリライトしてMDXを更新する
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

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
  const slug = url.pathname.replace(/^\/blog\//, '').replace(/\/$/, '');
  return path.join(ROOT, 'src', 'content', 'blog', `${slug}.mdx`);
}

async function rewriteForLowCtr(content: string, metrics: RewriteCandidate['metrics']): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: 'あなたはSEOタイトル改善の専門家です。',
    messages: [{
      role: 'user',
      content: `以下の記事のタイトルとmeta descriptionを改善してください。

現状指標:
- 表示回数: ${metrics.impressions}
- CTR: ${metrics.ctr.toFixed(2)}%
- 順位: ${metrics.position.toFixed(1)}位

改善目標: CTRを3%以上に向上させる

記事内容:
${content}

出力: フロントマターのtitleとdescriptionのみJSONで返してください。
{"title": "...", "description": "..."}`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return content;

  const { title, description } = JSON.parse(jsonMatch[0]);

  return content
    .replace(/^title: ".*"/m, `title: "${title}"`)
    .replace(/^description: ".*"/m, `description: "${description}"`);
}

async function rewriteBody(content: string, metrics: RewriteCandidate['metrics']): Promise<string> {
  // フロントマターと本文を分離
  const match = content.match(/^(---[\s\S]*?---\n)([\s\S]*)$/);
  if (!match) return content;

  const [, frontmatter, body] = match;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: 'あなたはSEO記事リライトの専門家です。検索順位を改善するために記事を改善します。',
    messages: [{
      role: 'user',
      content: `以下の記事をリライトしてください。

現状指標:
- 順位: ${metrics.position.toFixed(1)}位（目標: 10位以内）
- 表示回数: ${metrics.impressions}
- CTR: ${metrics.ctr.toFixed(2)}%

改善ポイント:
- 見出し構成の最適化
- E-E-A-Tの強化（具体例・データ追加）
- 読みやすさの向上
- 内部リンクのプレースホルダー追加

記事本文:
${body}

リライト後の本文のみ出力してください（フロントマター不要）。`,
    }],
  });

  const rewritten = response.content[0].type === 'text' ? response.content[0].text : body;
  const today = new Date().toISOString().split('T')[0];
  const updatedFrontmatter = frontmatter.replace(/---\n$/, `updatedDate: ${today}\n---\n`);

  return updatedFrontmatter + rewritten;
}

async function main() {
  const candidatesPath = path.join(ROOT, 'data', 'rewrite-candidates.json');
  const raw = await fs.readFile(candidatesPath, 'utf-8');
  const candidates: RewriteCandidate[] = JSON.parse(raw);

  if (candidates.length === 0) {
    console.log('リライト候補なし');
    return;
  }

  // 1日1件処理（コスト管理）
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

  let updated: string;
  if (target.reason === 'low-ctr') {
    updated = await rewriteForLowCtr(content, target.metrics);
    console.log('タイトル・description改善完了');
  } else {
    updated = await rewriteBody(content, target.metrics);
    console.log('本文リライト完了');
  }

  await fs.writeFile(filePath, updated, 'utf-8');

  // 処理済み候補を除外して保存
  await fs.writeFile(
    candidatesPath,
    JSON.stringify(candidates.slice(1), null, 2),
    'utf-8'
  );

  console.log(`更新完了: ${filePath}`);
}

main().catch(console.error);
