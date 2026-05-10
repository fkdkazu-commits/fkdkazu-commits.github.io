/**
 * OG画像自動生成スクリプト
 * sharpを使って記事タイトルからOG画像を生成する
 */
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(ROOT, 'src', 'content', 'blog');
const OG_DIR = path.join(ROOT, 'public', 'og');

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const BG_COLOR = { r: 15, g: 23, b: 42 };   // slate-900
const ACCENT_COLOR = '#3b82f6';               // blue-500

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

function wrapText(title: string, maxLen = 24): string[] {
  const lines: string[] = [];
  let current = '';
  for (const char of title) {
    current += char;
    if (current.length >= maxLen) {
      lines.push(current);
      current = '';
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

function buildSvg(title: string, keyword: string): string {
  const lines = wrapText(title);
  const lineHeight = 80;
  const startY = 240 - ((lines.length - 1) * lineHeight) / 2;

  const textElements = lines
    .map((line, i) => `<text x="600" y="${startY + i * lineHeight}" font-family="sans-serif" font-size="52" font-weight="bold" fill="white" text-anchor="middle">${line}</text>`)
    .join('\n');

  return `<svg width="${OG_WIDTH}" height="${OG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="rgb(${BG_COLOR.r},${BG_COLOR.g},${BG_COLOR.b})"/>
  <rect x="60" y="40" width="8" height="40" fill="${ACCENT_COLOR}" rx="4"/>
  <text x="82" y="72" font-family="sans-serif" font-size="24" fill="${ACCENT_COLOR}">ブログ</text>
  ${textElements}
  <text x="600" y="${startY + lines.length * lineHeight + 40}" font-family="sans-serif" font-size="28" fill="#94a3b8" text-anchor="middle">${keyword}</text>
  <rect x="60" y="${OG_HEIGHT - 80}" width="${OG_WIDTH - 120}" height="2" fill="#334155"/>
  <text x="600" y="${OG_HEIGHT - 44}" font-family="sans-serif" font-size="22" fill="#64748b" text-anchor="middle">blog.example.com</text>
</svg>`;
}

async function generateOgImage(slug: string, title: string, keyword: string): Promise<void> {
  await fs.mkdir(OG_DIR, { recursive: true });
  const outPath = path.join(OG_DIR, `${slug}.png`);

  if (await fs.access(outPath).then(() => true).catch(() => false)) return;

  const svg = buildSvg(title, keyword);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log(`OG画像生成: ${outPath}`);
}

async function main() {
  const files = await fs.readdir(BLOG_DIR);
  for (const file of files.filter((f) => f.endsWith('.mdx'))) {
    const content = await fs.readFile(path.join(BLOG_DIR, file), 'utf-8');
    const fm = extractFrontmatter(content);
    const slug = file.replace('.mdx', '');
    if (fm.title && fm.keyword) {
      await generateOgImage(slug, fm.title, fm.keyword);
    }
  }
  console.log('OG画像生成完了');
}

main().catch(console.error);
