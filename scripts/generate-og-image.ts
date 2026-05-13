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

function wrapText(title: string, maxLen = 22): string[] {
  // 優先度高: 文の切れ目になる記号 / 優先度低: 軽い区切り
  const major = new Set(['｜', '。', '？', '！', '、', '】', '）', '：']);
  const minor = new Set(['・', ' ', '　', '-']);
  const lines: string[] = [];
  let remaining = title;

  while (remaining.length > maxLen && lines.length < 2) {
    const lo = Math.floor(maxLen * 0.35); // 低めに設定し '？' '：' 等も拾う
    const hi = Math.min(Math.ceil(maxLen * 1.2), remaining.length - 1);
    let breakAt = -1;

    // 1. major 後: maxLen から lo へ後退スキャン
    for (let i = maxLen; i >= lo; i--) {
      if (i > 0 && major.has(remaining[i - 1])) { breakAt = i; break; }
      if (i < remaining.length && (remaining[i] === '【' || remaining[i] === '（')) { breakAt = i; break; }
    }
    // 2. major 後: maxLen+1 から hi へ前進スキャン
    if (breakAt === -1) {
      for (let i = maxLen + 1; i <= hi; i++) {
        if (major.has(remaining[i - 1])) { breakAt = i; break; }
        if (i < remaining.length && (remaining[i] === '【' || remaining[i] === '（')) { breakAt = i; break; }
      }
    }
    // 3. minor 後: maxLen から lo へ後退スキャン
    if (breakAt === -1) {
      for (let i = maxLen; i >= lo; i--) {
        if (i > 0 && minor.has(remaining[i - 1])) { breakAt = i; break; }
      }
    }
    // 4. 強制改行
    if (breakAt === -1) breakAt = maxLen;

    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }
  if (remaining) lines.push(remaining);
  return lines;
}

// Unsplash写真の上に重ねるオーバーレイ SVG（グラデーション + タイトル）
function buildOverlaySvg(title: string): string {
  const lines = wrapText(title);
  const maxLen = Math.max(...lines.map(l => l.length));
  const fontSize = maxLen <= 18 ? 56 : maxLen <= 22 ? 48 : 42;
  const lineHeight = fontSize + 16;
  const totalTextH = lines.length * lineHeight;

  const textBlockBottom = OG_HEIGHT - 130;
  const textStartY = textBlockBottom - totalTextH + lineHeight;

  const textElements = lines
    .map((line, i) =>
      `<text x="72" y="${textStartY + i * lineHeight}" font-family="'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" filter="url(#shadow)">${escapeXml(line)}</text>`,
    )
    .join('\n  ');

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

// フォールバック: radialGradient オーロラ + グリッド背景
function buildFallbackSvg(title: string): string {
  const lines = wrapText(title);
  const maxLen = Math.max(...lines.map(l => l.length));
  const fontSize = maxLen <= 18 ? 56 : maxLen <= 22 ? 48 : 42;
  const lineHeight = fontSize + 16;
  const totalTextH = lines.length * lineHeight;
  const textStartY = OG_HEIGHT / 2 - totalTextH / 2 + Math.round(fontSize * 0.6);

  const textElements = lines
    .map((line, i) =>
      `<text x="600" y="${textStartY + i * lineHeight}" font-family="'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" text-anchor="middle">${escapeXml(line)}</text>`,
    )
    .join('\n  ');

  return `<svg width="${OG_WIDTH}" height="${OG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- ベースグラデーション -->
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#060918"/>
      <stop offset="100%" stop-color="#0d0b22"/>
    </linearGradient>
    <!-- オーロラブロブ (radialGradient = フィルター不要で sharp で確実に描画) -->
    <radialGradient id="r1" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="#1d4ed8" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="#1d4ed8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="r2" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="#7c3aed" stop-opacity="0.68"/>
      <stop offset="100%" stop-color="#7c3aed" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="r3" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="#0891b2" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#0891b2" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="r4" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="#4338ca" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#4338ca" stop-opacity="0"/>
    </radialGradient>
    <!-- アクセントライン -->
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="${ACCENT_COLOR}"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
    <!-- グリッド線 -->
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.045)" stroke-width="0.8"/>
    </pattern>
    <!-- 交点ドット -->
    <pattern id="gdot" width="40" height="40" patternUnits="userSpaceOnUse">
      <circle cx="0" cy="0" r="1.3" fill="white" opacity="0.13"/>
    </pattern>
  </defs>

  <!-- ベース -->
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#base)"/>

  <!-- グリッド -->
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#grid)"/>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#gdot)"/>

  <!-- オーロラブロブ (各コーナーに配置・中央でうっすら重なる) -->
  <ellipse cx="150"  cy="200"  rx="540" ry="370" fill="url(#r1)"/>
  <ellipse cx="1060" cy="450"  rx="500" ry="320" fill="url(#r2)"/>
  <ellipse cx="980"  cy="90"   rx="400" ry="250" fill="url(#r3)"/>
  <ellipse cx="110"  cy="520"  rx="300" ry="210" fill="url(#r4)"/>

  <!-- 上部アクセントライン -->
  <rect x="0" y="0" width="${OG_WIDTH}" height="4" fill="url(#accent)"/>

  <!-- サイト名（左上） -->
  <rect x="48" y="36" width="6" height="36" fill="${ACCENT_COLOR}" rx="3"/>
  <text x="64" y="64" font-family="sans-serif" font-size="24" font-weight="600" fill="white">${SITE_NAME}</text>

  <!-- タイトル -->
  ${textElements}

  <!-- 下部アクセントライン -->
  <rect x="0" y="${OG_HEIGHT - 4}" width="${OG_WIDTH}" height="4" fill="url(#accent)"/>
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
    const svg = buildFallbackSvg(title);
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
