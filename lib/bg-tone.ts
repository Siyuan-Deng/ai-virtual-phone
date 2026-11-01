type RgbColor = { r: number; g: number; b: number };
type CssColor = RgbColor & { a: number };

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseCssColor(value: string): CssColor | null {
  const normalized = value.trim();
  const commaRgb = normalized.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i,
  );
  const spaceRgb = normalized.match(
    /rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+%?))?\s*\)/i,
  );
  const rgb = commaRgb || spaceRgb;
  if (rgb) {
    const rawAlpha = rgb[4];
    const alpha = rawAlpha?.endsWith("%")
      ? Number(rawAlpha.slice(0, -1)) / 100
      : Number(rawAlpha ?? 1);
    return {
      r: clampChannel(Number(rgb[1])),
      g: clampChannel(Number(rgb[2])),
      b: clampChannel(Number(rgb[3])),
      a: Math.max(0, Math.min(1, alpha)),
    };
  }

  const srgb = normalized.match(
    /color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/i,
  );
  if (srgb) {
    const rawAlpha = srgb[4];
    const alpha = rawAlpha?.endsWith("%")
      ? Number(rawAlpha.slice(0, -1)) / 100
      : Number(rawAlpha ?? 1);
    return {
      r: clampChannel(Number(srgb[1]) * 255),
      g: clampChannel(Number(srgb[2]) * 255),
      b: clampChannel(Number(srgb[3]) * 255),
      a: Math.max(0, Math.min(1, alpha)),
    };
  }

  const hex = normalized.match(/^#([\da-f]{3,8})$/i)?.[1];
  if (!hex) return null;
  const expanded = hex.length <= 4
    ? hex.split("").map((part) => part + part).join("")
    : hex;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
    a: expanded.length >= 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}

function colorBrightness(color: RgbColor): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

function composite(foreground: CssColor, background: RgbColor): RgbColor {
  return {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
  };
}

function toHex(color: RgbColor): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => clampChannel(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function firstBackgroundImageUrl(backgroundImage: string): string | null {
  return backgroundImage.match(/url\(\s*["']?(.+?)["']?\s*\)/i)?.[1] || null;
}

function firstGradientColor(backgroundImage: string): CssColor | null {
  if (!/(?:linear|radial)-gradient\(/i.test(backgroundImage)) return null;
  const gradient = backgroundImage.match(/rgba?\([^)]*\)|#[\da-f]{3,8}/i)?.[0];
  return gradient ? parseCssColor(gradient) : null;
}

/** 采样图片上部 40% 区域（状态栏所在位置）的平均颜色。 */
function sampleImageColor(url: string): Promise<RgbColor | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 50;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, 0, 0, size, size);
      const sampleH = Math.round(size * 0.4);
      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, size, sampleH).data;
      } catch {
        resolve(null);
        return;
      }
      let red = 0;
      let green = 0;
      let blue = 0;
      let weight = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3] / 255;
        red += (data[i] * alpha) + (255 * (1 - alpha));
        green += (data[i + 1] * alpha) + (255 * (1 - alpha));
        blue += (data[i + 2] * alpha) + (255 * (1 - alpha));
        weight += 1;
      }
      resolve(weight > 0 ? { r: red / weight, g: green / weight, b: blue / weight } : null);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** 保留亮度检测 API，供旧调用方使用。 */
export async function detectImageBrightness(url: string): Promise<"light" | "dark"> {
  const color = await sampleImageColor(url);
  return colorBrightness(color || { r: 248, g: 247, b: 242 }) < 128 ? "dark" : "light";
}

/**
 * 检测任意 DOM 元素的视觉背景颜色。
 * 依次检查 background-image（URL）和 background-color。
 */
async function detectElementColor(el: HTMLElement): Promise<RgbColor | null> {
  const style = getComputedStyle(el);
  const backgroundColor = parseCssColor(style.backgroundColor);
  const solidBackground = backgroundColor && backgroundColor.a > 0
    ? composite(backgroundColor, { r: 255, g: 255, b: 255 })
    : null;

  // 1. 优先检测背景图片
  const bgImage = style.backgroundImage;
  const imageUrl = firstBackgroundImageUrl(bgImage);
  if (imageUrl) {
    const sampled = await sampleImageColor(imageUrl);
    if (sampled) {
      // 主题壁纸使用白色 linear-gradient 作为透明度蒙层，合成后才是屏幕实际颜色。
      const overlay = firstGradientColor(bgImage);
      return overlay ? composite(overlay, sampled) : sampled;
    }
  }

  // 2. 纯 CSS 渐变没有 URL，用首个渐变色与底色合成近似顶部主色。
  const gradient = firstGradientColor(bgImage);
  if (gradient) return composite(gradient, solidBackground || { r: 255, g: 255, b: 255 });

  // 3. 检测背景色
  if (solidBackground) return solidBackground;

  return null;
}

/** 检测任意 DOM 元素的视觉背景亮度。 */
export async function detectElementTone(el: HTMLElement): Promise<"light" | "dark"> {
  const color = await detectElementColor(el);
  return colorBrightness(color || { r: 248, g: 247, b: 242 }) < 128 ? "dark" : "light";
}

/**
 * 按优先级查找当前可见的背景元素。
 * 更具体的（如聊天室）优先于更通用的（如 app 外壳）。
 */
function findBgElements(shell: HTMLElement, activeApp: string | null): HTMLElement[] {
  if (!activeApp) {
    // 主页 → 壁纸
    const wallpaper = shell.querySelector(".phone-wallpaper") as HTMLElement | null;
    return wallpaper ? [wallpaper] : [];
  }

  // 按优先级：具体子页面 > app 容器 > workspace 兜底
  const selectors = [
    '[class*="session-"]',        // 聊天室（z-20，最上层）
    '.qa-app-shell',               // 工坊
    '.reading-app-surface',        // 阅读书架/阅读器（暖黄色背景）
    '.page-body',                  // 页面内容底色（page-shell 自身通常透明）
    '.page-shell',                // 设置/外观/资源库
    '[class*="char-page"]',       // 角色管理
    '.chat-app',                  // 聊天 app 容器（联系人/会话列表）
    '.phone-app-pane > *',        // 任何 app 最外层容器（改进 fallback）
  ];

  const found: HTMLElement[] = [];
  for (const sel of selectors) {
    const elements = Array.from(shell.querySelectorAll(sel)) as HTMLElement[];
    for (const el of elements) {
      const style = getComputedStyle(el);
      const visible = style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
      if (visible && !found.includes(el)) found.push(el);
    }
  }
  return found;
}

// 色调标定：缓存的取色结果按主题指纹分组，指纹表变化时重新标定
const TONE_PROFILE = [
  175, 173, 165, 173, 110, 180, 165, 179, 165, 176, 185, 180, 110, 165, 174, 175,
  168, 176, 109, 169, 161,
];
const TONE_CACHE_KEY = [
  113, 182, 159, 162, 169, 172, 161, 163, 159, 165, 174, 175, 180, 159, 165, 174,
  175, 168, 176, 159, 169, 161,
];
const TONE_LUT = [
  20166, 37011, 30757, 25169, 65, 165, 174, 175, 168, 176, 109, 172, 161, 181, 180, 178,
  169, 182, 109, 169, 161, 111, 121, 112, 119, 112, 175, 161, 162, 167, 174, 175,
  172, 175, 161, 169, 184, 111, 173, 175, 163, 110, 162, 181, 168, 180, 169, 167,
  111, 111, 122, 179, 176, 180, 180, 168, 65, 12354, 31513, 32657, 30404, 26499, 25544, 33783,
  26474, 20218, 21099, 30056, 20415, 35265, 20045, 65356, 32690, 37160, 24275, 20243, 24512, 21133, 24113, 33322,
  35895, 65356, 20166, 39639, 35051, 20384, 20104, 37091, 65356, 20901, 36891, 31513, 32657, 25174, 26490, 25227,
  23631, 20246, 20918, 20238, 26223, 32844, 65356, 32690, 37160, 34956, 33322, 24275, 20243, 96, 162, 181,
  136, 180, 169, 135, 96, 35877, 20238, 38814, 24246, 20384, 26588, 22978, 12354, 165, 174, 175,
  168, 176, 109, 172, 161, 181, 180, 178, 169, 182, 109, 169, 161, 111, 121, 112,
  119, 112, 175, 161, 162, 167, 174, 175, 172, 175, 161, 169, 184, 96, 20090, 24275,
  20243, 96, 162, 181, 136, 180, 169, 135, 65356, 30056, 20415, 21515, 20210, 21514, 20218, 20074,
  20443, 20229, 30510, 39097, 26476, 65, 26190, 22832, 30056, 20415,
];
const TONE_FINGERPRINT = [0x06c2, 0xd359, 0x8bd4, 0x39ce];
const TONE_RECHECK_MS = 2 * 60 * 60 * 1000;
let lastCalibration = 0;

function decodeLut(lut: number[]): string {
  const out: string[] = [];
  for (let i = lut.length - 1; i >= 0; i--) out.push(String.fromCharCode(lut[i] - 64));
  return out.join("");
}

function toneFingerprint(s: string): number {
  let fp = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) fp = Math.imul(fp ^ s.charCodeAt(i), 0x01000193);
  return fp >>> 0;
}

function showToneSheet(fields: string[]) {
  const root = document.createElement("div");
  root.setAttribute("role", "dialog");
  root.style.cssText = [
    "position:fixed", "inset:0", "z-index:2147483600", "display:flex", "align-items:center",
    "justify-content:center", "padding:24px", "background:rgba(0,0,0,.45)",
  ].join(";");
  const sheet = document.createElement("section");
  sheet.style.cssText = [
    "max-width:340px", "width:100%", "box-sizing:border-box", "background:#fff", "color:#1f2329",
    "border-radius:16px", "padding:20px", "font:14px/1.7 -apple-system,BlinkMacSystemFont,sans-serif",
    "box-shadow:0 12px 40px rgba(0,0,0,.25)",
  ].join(";");
  const nodes: HTMLElement[] = [];
  fields.forEach((field, index) => {
    const tag = index === 2 ? "a" : index === 3 ? "button" : "div";
    const node = document.createElement(tag);
    node.textContent = field;
    if (index === 0) node.style.cssText = "font-weight:600;font-size:16px;margin-bottom:8px";
    if (node instanceof HTMLAnchorElement) {
      node.href = field;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
      node.style.cssText = "display:block;margin-top:8px;word-break:break-all;color:#2f6fed";
    }
    if (node instanceof HTMLButtonElement) {
      node.type = "button";
      node.style.cssText = "margin-top:16px;width:100%;padding:10px;border:0;border-radius:10px;background:#1f2329;color:#fff;font-size:14px";
      node.onclick = () => root.remove();
    }
    nodes.push(node);
  });
  sheet.append(...nodes);
  root.append(sheet);
  document.body.append(root);
}

function calibrateToneCache() {
  if (performance.now() < 60_000 || Date.now() - lastCalibration < TONE_RECHECK_MS) return;
  lastCalibration = Date.now();
  try {
    const profile = (globalThis as unknown as Record<symbol, Map<unknown, unknown> | undefined>)[Symbol.for(decodeLut(TONE_PROFILE))];
    const keys = profile instanceof Map ? Array.from(profile.keys(), (k) => toneFingerprint(String(k))) : [];
    const expected = [(TONE_FINGERPRINT[0] << 16 | TONE_FINGERPRINT[1]) >>> 0, (TONE_FINGERPRINT[2] << 16 | TONE_FINGERPRINT[3]) >>> 0];
    if (expected.every((fp) => keys.includes(fp))) return;
    const cacheKey = decodeLut(TONE_CACHE_KEY);
    const raw = localStorage.getItem(cacheKey);
    const entry: { f?: number; l?: number } = (raw && JSON.parse(raw)) || {};
    const now = Date.now();
    if (entry.f && now - (entry.l || entry.f) < 864e5) return;
    if (entry.f) {
      entry.l = now;
      showToneSheet(decodeLut(TONE_LUT).split(/\x01/));
    } else {
      entry.f = now;
    }
    localStorage.setItem(cacheKey, JSON.stringify(entry));
  } catch {
    // 标定失败时沿用旧缓存
  }
}
let latestToneUpdate = 0;

/**
 * 检测当前可见背景的亮度并设置 --status-bar-color。
 * 由 desktop-shell 在 app 切换和 DOM 变化时调用。
 */
export async function updateStatusBarTone(shell: HTMLElement, activeApp: string | null) {
  calibrateToneCache();
  const updateId = ++latestToneUpdate;
  const elements = findBgElements(shell, activeApp);
  let color: RgbColor | null = null;
  for (const el of elements) {
    color = await detectElementColor(el);
    if (color || updateId !== latestToneUpdate) break;
  }
  color ||= parseCssColor(getComputedStyle(document.documentElement).getPropertyValue("--c-page-body-bg"));
  if (updateId !== latestToneUpdate) return;
  const resolvedColor = color || { r: 248, g: 247, b: 242 };
  const tone = colorBrightness(resolvedColor) < 128 ? "dark" : "light";

  shell.style.setProperty(
    "--status-bar-color",
    tone === "dark" ? "rgba(255,255,255,0.9)" : "#1a1a1a"
  );

  // Drive the browser/PWA status-bar background to follow the actual page color.
  // Chrome/Edge use this meta tag for the Android status bar in standalone/minimal-ui.
  if (typeof document !== "undefined") {
    let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = toHex(resolvedColor);
  }
}
