/**
 * OG画像自動生成スクリプト
 * Unsplash APIでキーワードに合った写真を取得し、タイトルオーバーレイを重ねる
 * UNSPLASH_ACCESS_KEY が未設定の場合は SVG フォールバック
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
const ACCENT_COLOR = '#3b82f6';

function extractFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const [key, ...vals] = line.split(':');
    if (key && vals.length) result[key.trim()] = vals.join(':').trim().replace(/^"|"$/g, '');
  }
  return result;
}

function wrapText(title: string, maxLen = 22): string[] {
  const lines: string[] = [];
  let current = '';
  for (const char of title) {
    current += char;
    if (current.length >= maxLen) { lines.push(current); current = ''; }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

// Unsplash写真の上に重ねるグラデーション + タイトルテキスト SVG
function buildOverlaySvg(title: string): string {
  const lines = wrapText(title);
  const lineHeight = 72;
  const totalTextH = lines.length * lineHeight;
  const textStartY = OG_HEIGHT - 120 - totalTextH + lineHeight;

  const textElements = lines
    .map((line, i) => `<text x="80" y="${textStartY + i * lineHeight}" font-family="sans-serif" font-size="54" font-weight="bold" fill="white">${line}</text>`)
    .join('\n');

  return `<svg width="${OG_WIDTH}" height="${OG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="black" stop-opacity="0"/>
      <stop offset="50%" stop-color="black" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.85"/>
    </linearGradient>
  </defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#grad)"/>
  <rect x="60" y="${OG_HEIGHT - 110}" width="8" height="44" fill="${ACCENT_COLOR}" rx="4"/>
  <text x="82" y="${OG_HEIGHT - 74}" font-family="sans-serif" font-size="22" fill="${ACCENT_COLOR}">AI メディア</text>
  ${textElements}
  <text x="${OG_WIDTH - 20}" y="${OG_HEIGHT - 20}" font-family="sans-serif" font-size="18" fill="#94a3b8" text-anchor="end">Photo: Unsplash</text>
</svg>`;
}

// Unsplash APIで写真を取得してバッファで返す
async function fetchUnsplashPhoto(keyword: string): Promise<Buffer | null> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) return null;

  try {
    const searchRes = await fetch(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(keyword)}&orientation=landscape&count=1`,
      { headers: { Authorization: `Client-ID ${accessKey}` } },
    );
    if (!searchRes.ok) {
      console.warn(`Unsplash API エラー: ${searchRes.status}`);
      return null;
    }
    const [photo] = await searchRes.json() as { urls: { regular: string }; links: { download_location: string } }[];
    if (!photo) return null;

    // Unsplash利用規約に基づきダウンロードを記録
    fetch(photo.links.download_location, { headers: { Authorization: `Client-ID ${accessKey}` } }).catch(() => {});

    const imgRes = await fetch(`${photo.urls.regular}&w=${OG_WIDTH}&h=${OG_HEIGHT}&fit=crop`);
    if (!imgRes.ok) return null;
    return Buffer.from(await imgRes.arrayBuffer());
  } catch (e) {
    console.warn('Unsplash取得失敗:', e);
    return null;
  }
}

// フォールバック: SVGのみのOG画像
function buildFallbackSvg(title: string, keyword: string): string {
  const lines = wrapText(title);
  const lineHeight = 80;
  const startY = 240 - ((lines.length - 1) * lineHeight) / 2;
  const textElements = lines
    .map((line, i) => `<text x="600" y="${startY + i * lineHeight}" font-family="sans-serif" font-size="52" font-weight="bold" fill="white" text-anchor="middle">${line}</text>`)
    .join('\n');
  return `<svg width="${OG_WIDTH}" height="${OG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="rgb(15,23,42)"/>
  <rect x="60" y="40" width="8" height="40" fill="${ACCENT_COLOR}" rx="4"/>
  <text x="82" y="72" font-family="sans-serif" font-size="24" fill="${ACCENT_COLOR}">AI メディア</text>
  ${textElements}
  <text x="600" y="${startY + lines.length * lineHeight + 40}" font-family="sans-serif" font-size="28" fill="#94a3b8" text-anchor="middle">${keyword}</text>
</svg>`;
}

async function generateOgImage(slug: string, title: string, keyword: string): Promise<void> {
  await fs.mkdir(OG_DIR, { recursive: true });
  const outPath = path.join(OG_DIR, `${slug}.png`);

  // 既存ファイルがあればスキップ（再生成したい場合は削除する）
  if (await fs.access(outPath).then(() => true).catch(() => false)) return;

  const photoBuffer = await fetchUnsplashPhoto(keyword);

  if (photoBuffer) {
    const overlay = buildOverlaySvg(title);
    await sharp(photoBuffer)
      .resize(OG_WIDTH, OG_HEIGHT, { fit: 'cover', position: 'center' })
      .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
      .png()
      .toFile(outPath);
    console.log(`OG画像生成 (Unsplash): ${slug}.png`);
  } else {
    const svg = buildFallbackSvg(title, keyword);
    await sharp(Buffer.from(svg)).png().toFile(outPath);
    console.log(`OG画像生成 (SVG fallback): ${slug}.png`);
  }
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
