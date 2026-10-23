/**
 * 把 CSS 里的 @import 抽出来单独返回。
 *
 * @import 不能留在会话 <style> 里：iOS WebKit 在 @import 仍在加载/重试期间
 * 会把整张样式表的所有规则都挂起。用户常引 Google Fonts，在无法直连的网络
 * 下该请求反复失败重试，整张自定义 CSS 就会在"生效↔失效"之间来回翻转——
 * 表现为剧情页拉到顶/底时页面在有 CSS 和无 CSS 之间闪烁。抽成独立的
 * <link rel="stylesheet"> 后字体加载失败只影响字体本身，其余规则始终生效。
 */
export function extractCssImports(raw: string): { imports: string[]; css: string } {
  const imports: string[] = [];
  if (!raw || !raw.includes("@import")) return { imports, css: raw };
  const css = raw.replace(
    /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)[^;]*;/gi,
    (_match, _q1, urlInParens: string | undefined, _q2, bareUrl: string | undefined) => {
      const url = (urlInParens || bareUrl || "").trim();
      if (url) imports.push(url);
      return "";
    }
  );
  return { imports, css };
}

/**
 * Scope raw CSS so every rule selector is prefixed with a scope selector.
 * - `body` / `html` / `:root` selectors are replaced with the scope selector.
 *   Pass `bodySelector` when `body` sits one level below the scope (e.g. a re-hosted
 *   iframe document): `body` then maps there and `html` / `:root` stay on the scope.
 * - `@keyframes` / `@font-face` blocks are passed through unchanged.
 * - Media queries are handled recursively.
 */
export function scopeSessionCSS(raw: string, scopeSelector: string, bodySelector: string = scopeSelector): string {
  if (!raw.trim()) return "";

  const result: string[] = [];
  let i = 0;

  while (i < raw.length) {
    // Skip whitespace
    while (i < raw.length && /\s/.test(raw[i])) {
      result.push(raw[i]);
      i++;
    }
    if (i >= raw.length) break;

    // Skip comments
    if (raw[i] === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      if (end === -1) {
        result.push(raw.slice(i));
        break;
      }
      result.push(raw.slice(i, end + 2));
      i = end + 2;
      continue;
    }

    // Handle @-rules
    if (raw[i] === "@") {
      const atRuleMatch = raw.slice(i).match(/^@([\w-]+)\s*/);
      if (atRuleMatch) {
        const atName = atRuleMatch[1].toLowerCase();

        // @import — pass through unchanged (e.g. Google Fonts)
        if (atName === "import") {
          const semiEnd = raw.indexOf(";", i);
          if (semiEnd === -1) {
            result.push(raw.slice(i));
            break;
          }
          result.push(raw.slice(i, semiEnd + 1));
          i = semiEnd + 1;
          continue;
        }

        // Pass-through rules (don't scope)
        if (atName === "keyframes" || atName === "font-face") {
          const braceStart = raw.indexOf("{", i);
          if (braceStart === -1) {
            result.push(raw.slice(i));
            break;
          }
          const blockEnd = findMatchingBrace(raw, braceStart);
          result.push(raw.slice(i, blockEnd + 1));
          i = blockEnd + 1;
          continue;
        }

        // Media queries and other container rules — recurse into body
        if (atName === "media" || atName === "supports" || atName === "layer") {
          const braceStart = raw.indexOf("{", i);
          if (braceStart === -1) {
            result.push(raw.slice(i));
            break;
          }
          const blockEnd = findMatchingBrace(raw, braceStart);
          const prelude = raw.slice(i, braceStart + 1);
          const body = raw.slice(braceStart + 1, blockEnd);
          result.push(prelude);
          result.push(scopeSessionCSS(body, scopeSelector, bodySelector));
          result.push("}");
          i = blockEnd + 1;
          continue;
        }
      }
    }

    // Regular rule: selector { ... }
    const braceStart = raw.indexOf("{", i);
    if (braceStart === -1) {
      // No more braces — remaining text is malformed, just push it
      result.push(raw.slice(i));
      break;
    }

    const selectorText = raw.slice(i, braceStart).trim();
    const blockEnd = findMatchingBrace(raw, braceStart);
    const body = raw.slice(braceStart, blockEnd + 1);

    // Scope each selector in comma-separated list
    const scopedSelector = selectorText
      .split(",")
      .map((sel) => scopeSingleSelector(sel.trim(), scopeSelector, bodySelector))
      .join(", ");

    result.push(scopedSelector + " " + body);
    i = blockEnd + 1;
  }

  return result.join("");
}

function scopeSingleSelector(sel: string, scope: string, body: string = scope): string {
  if (!sel) return sel;
  const lower = sel.toLowerCase();
  const targetOf = (word: string) => (word.toLowerCase() === "body" ? body : scope);
  // Replace body/html/:root with the scope selector
  if (lower === "body" || lower === "html" || lower === ":root") {
    return targetOf(lower);
  }
  // Selectors starting with body/html/:root — replace the element part
  const spaced = sel.match(/^(body|html|:root)\s+/i);
  if (spaced) {
    return targetOf(spaced[1]) + " " + sel.slice(spaced[0].length);
  }
  const dotted = sel.match(/^(body|html|:root)\./i);
  if (dotted) {
    return targetOf(dotted[1]) + sel.slice(dotted[1].length);
  }
  // 选择器就是 scope 本身（如用户写 .chat-app { --var: ... }）：直接返回 scope，
  // 否则会被错误地变成 ".chat-app .chat-app"，导致变量没法挂到 scope 元素上
  if (sel === scope) {
    return scope;
  }
  // 选择器以 scope 开头并跟着空格/伪类/属性（如 .chat-app .foo / .chat-app:hover / .chat-app[data-x]）：
  // 已经包含 scope 了，不要重复前缀，否则也会失效
  if (sel.startsWith(scope + " ") || sel.startsWith(scope + ":") || sel.startsWith(scope + "[") || sel.startsWith(scope + ".") || sel.startsWith(scope + ">")) {
    return sel;
  }
  // Normal selector — prefix with scope
  return scope + " " + sel;
}

function findMatchingBrace(text: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}
