/**
 * OG画像自動生成スクリプト
 * Unsplash APIでキーワードに合った写真を取得し、タイトルオーバーレイを重ねる
 * UNSPLASH_ACCESS_KEY が未設定の場合は C:\Users\fkdka\.secrets\.env を参照
 * どちらもなければ SVG フォールバック
 */
import sharp from 'sharp';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ローカル実行用: シークレットフォルダの .env を自動読み込み
function loadLocalSecrets(): void {
  if (process.env.UNSPLASH_ACCESS_KEY) return; // 既にセット済み（GitHub Actions等）
  const secretsEnv = 'C:\\Users\\fkdka\\.secrets\\.env';
  try {
    const content = fsSync.readFileSync(secretsEnv, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
      if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // ファイルが存在しない場合は無視（GitHub Actions では env 経由で渡す）
  }
}
loadLocalSecrets();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BLOG_DIR = path.join(ROOT, 'src', 'content', 'blog');
const OG_DIR = path.join(ROOT, 'public', 'og');

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const ACCENT_COLOR = '#3b82f6';
const SITE_NAME = 'AI メディア';

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

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrapText(title: string, maxLen = 20): string[] {
  const lines: string[] = [];
  let current = '';
  for (const char of title) {
    current += char;
    if (current.length >= maxLen) { lines.push(current); current = ''; }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

// Unsplash写真の上に重ねるオーバーレイ SVG（グラデーション + バッジ + タイトル）
function buildOverlaySvg(title: string, keyword: string): string {
  const lines = wrapText(title, 20);
  const fontSize = lines.length <= 2 ? 56 : 48;
  const lineHeight = fontSize + 16;
  const totalTextH = lines.length * lineHeight;

  // テキストブロックを下から130pxの位置に配置
  const textBlockBottom = OG_HEIGHT - 130;
  const textStartY = textBlockBottom - totalTextH + lineHeight;

  const textElements = lines
    .map((line, i) =>
      `<text x="72" y="${textStartY + i * lineHeight}" font-family="'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" filter="url(#shadow)">${escapeXml(line)}</text>`,
    )
    .join('\n  ');

  // キーワードバッジ
  const kwText = escapeXml(keyword);
  const kwWidth = Math.min(keyword.length * 18 + 32, 300);

  return `<svg width="${OG_WIDTH}" height="${OG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#000000" stop-opacity="0"/>
      <stop offset="40%"  stop-color="#000000" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.88"/>
    </linearGradient>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="130%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="black" flood-opacity="0.6"/>
    </filter>
  </defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#grad)"/>

  <!-- サイト名（左上） -->
  <rect x="48" y="44" width="6" height="36" fill="${ACCENT_COLOR}" rx="3"/>
  <text x="64" y="72" font-family="sans-serif" font-size="24" font-weight="600" fill="white">${SITE_NAME}</text>

  <!-- キーワードバッジ（タイトルの上） -->
  <rect x="68" y="${textStartY - lineHeight - 12}" width="${kwWidth}" height="36" rx="18" fill="${ACCENT_COLOR}" fill-opacity="0.9"/>
  <text x="${68 + kwWidth / 2}" y="${textStartY - lineHeight + 9}" font-family="sans-serif" font-size="20" font-weight="600" fill="white" text-anchor="middle">${kwText}</text>

  <!-- タイトル -->
  ${textElements}

  <!-- 下部アクセントライン -->
  <rect x="0" y="${OG_HEIGHT - 6}" width="${OG_WIDTH}" height="6" fill="${ACCENT_COLOR}"/>

  <!-- Photo credit -->
  <text x="${OG_WIDTH - 16}" y="${OG_HEIGHT - 16}" font-family="sans-serif" font-size="16" fill="rgba(255,255,255,0.5)" text-anchor="end">Photo: Unsplash</text>
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

// フォールバック: グラデーション背景 + 装飾のSVG OG画像
function buildFallbackSvg(title: string, keyword: string): string {
  const lines = wrapText(title, 20);
  const fontSize = lines.length <= 2 ? 56 : 48;
  const lineHeight = fontSize + 16;
  const totalTextH = lines.length * lineHeight;
  const textStartY = OG_HEIGHT / 2 - totalTextH / 2 + 30;

  const textElements = lines
    .map((line, i) =>
      `<text x="600" y="${textStartY + i * lineHeight}" font-family="'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" text-anchor="middle">${escapeXml(line)}</text>`,
    )
    .join('\n  ');

  const kwText = escapeXml(keyword);
  const kwWidth = Math.min(keyword.length * 18 + 32, 320);

  return `<svg width="${OG_WIDTH}" height="${OG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#0f172a"/>
      <stop offset="50%"  stop-color="#1e1b4b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="${ACCENT_COLOR}"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>

  <!-- 背景 -->
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#bg)"/>

  <!-- 装飾: 右上の円 -->
  <circle cx="${OG_WIDTH - 80}" cy="80" r="200" fill="#3b82f6" fill-opacity="0.06"/>
  <circle cx="${OG_WIDTH - 60}" cy="60" r="100" fill="#8b5cf6" fill-opacity="0.08"/>

  <!-- 装飾: 左下の円 -->
  <circle cx="80" cy="${OG_HEIGHT - 80}" r="150" fill="${ACCENT_COLOR}" fill-opacity="0.06"/>

  <!-- 上部アクセントライン -->
  <rect x="0" y="0" width="${OG_WIDTH}" height="5" fill="url(#accent)"/>

  <!-- サイト名（左上） -->
  <rect x="48" y="36" width="6" height="36" fill="${ACCENT_COLOR}" rx="3"/>
  <text x="64" y="64" font-family="sans-serif" font-size="24" font-weight="600" fill="white">${SITE_NAME}</text>

  <!-- キーワードバッジ -->
  <rect x="${600 - kwWidth / 2}" y="${textStartY - lineHeight - 16}" width="${kwWidth}" height="38" rx="19" fill="url(#accent)" fill-opacity="0.9"/>
  <text x="600" y="${textStartY - lineHeight + 12}" font-family="sans-serif" font-size="21" font-weight="600" fill="white" text-anchor="middle">${kwText}</text>

  <!-- タイトル -->
  ${textElements}

  <!-- 下部アクセントライン -->
  <rect x="0" y="${OG_HEIGHT - 5}" width="${OG_WIDTH}" height="5" fill="url(#accent)"/>
</svg>`;
}

async function generateOgImage(slug: string, title: string, keyword: string): Promise<void> {
  await fs.mkdir(OG_DIR, { recursive: true });
  const outPath = path.join(OG_DIR, `${slug}.png`);

  // 既存ファイルがあればスキップ（再生成したい場合は削除する）
  if (await fs.access(outPath).then(() => true).catch(() => false)) return;

  const photoBuffer = await fetchUnsplashPhoto(keyword);

  if (photoBuffer) {
    const overlay = buildOverlaySvg(title, keyword);
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
