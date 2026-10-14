// A deliberately small Markdown subset: source text is never treated as HTML.
// Only these renderers create markup, and every text/attribute value is escaped.
export function renderMarkdown(text: string, baseUrl?: string, depth = 0): string {
  const resolvedBaseUrl = baseUrl ?? (typeof window === 'undefined' ? 'http://localhost/' : window.location.href);
  if (depth >= 16) return `<p>${escapeHtml(text)}</p>`;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  const headingPattern = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
  const listPattern = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/;
  const startsBlock = (line: string): boolean => fencePattern.test(line) || headingPattern.test(line) || listPattern.test(line);

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(fencePattern);
    if (fence) {
      const marker = fence[1];
      const closingFence = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
      const code: string[] = [];
      index++;
      while (index < lines.length && !closingFence.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      // Fence info (e.g. a language name) is intentionally not inserted into HTML.
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(headingPattern);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown((heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, ''), resolvedBaseUrl)}</h${level}>`);
      index++;
      continue;
    }
    const list = line.match(listPattern);
    if (list) {
      const ordered = /^\d/.test(list[2]);
      const tag = ordered ? 'ol' : 'ul';
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(listPattern);
        if (!item || item[1].length !== list[1].length || /^\d/.test(item[2]) !== ordered) break;
        const indent = item[1].length + item[2].length + item[3].length;
        const content = [item[4]];
        index++;
        while (index < lines.length) {
          const continuation = lines[index];
          if (continuation.startsWith(' '.repeat(indent))) {
            content.push(continuation.slice(indent));
            index++;
          } else if (!continuation.trim() && (lines[index + 1] ?? '').startsWith(' '.repeat(indent))) {
            content.push('');
            index++;
          } else break;
        }
        items.push(`<li>${renderMarkdown(content.join('\n'), resolvedBaseUrl, depth + 1)}</li>`);
        if (!lines[index]?.trim() && lines[index + 1]?.match(listPattern)) index++;
      }
      const start = ordered ? ` start="${Number.parseInt(list[2], 10)}"` : '';
      blocks.push(`<${tag}${start}>${items.join('')}</${tag}>`);
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) paragraph.push(lines[index++]);
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join('\n'), resolvedBaseUrl)}</p>`);
  }
  return blocks.join('');
}

function renderInlineMarkdown(text: string, baseUrl: string, allowLinks = true, depth = 0): string {
  if (depth >= 16) return escapeHtml(text);
  let html = '';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const escaped = rest.match(/^\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/);
    if (escaped) {
      html += escapeHtml(escaped[1]);
      index += escaped[0].length;
      continue;
    }
    const code = rest.match(/^(`+)([\s\S]*?)\1(?!`)/);
    if (code) {
      html += `<code>${escapeHtml(code[2].replace(/\n/g, ' '))}</code>`;
      index += code[0].length;
      continue;
    }
    if (allowLinks && text[index] === '[') {
      const link = readMarkdownLink(text, index);
      if (link) {
        const href = safeMarkdownHref(link.destination, baseUrl);
        html += href === null
          ? escapeHtml(text.slice(index, link.end))
          : `<a href="${escapeAttribute(href)}">${renderInlineMarkdown(link.label, baseUrl, false, depth + 1)}</a>`;
        index = link.end;
        continue;
      }
    }
    const emphasis = readEmphasis(text, index);
    if (emphasis) {
      const content = renderInlineMarkdown(emphasis.content, baseUrl, allowLinks, depth + 1);
      html += emphasis.marker.length === 3 ? `<strong><em>${content}</em></strong>` : emphasis.marker.length === 2 ? `<strong>${content}</strong>` : `<em>${content}</em>`;
      index = emphasis.end;
      continue;
    }
    if (text[index] === '\n' || rest.startsWith('\\\n')) {
      html = html.replace(/ +$/, '');
      html += '<br />';
      index += text[index] === '\n' ? 1 : 2;
      continue;
    }
    html += escapeHtml(text[index]);
    index++;
  }
  return html;
}

function readEmphasis(text: string, start: number): { marker: string; content: string; end: number } | null {
  const opener = text.slice(start).match(/^(\*\*\*|___|\*\*|__|\*|_)/)?.[1];
  if (!opener || !text[start + opener.length]?.trim() || (opener.startsWith('_') && /[\p{L}\p{N}]/u.test(text[start - 1] ?? ''))) return null;
  const contentStart = start + opener.length;
  for (let index = contentStart; index < text.length;) {
    if (text[index] === '\\') { index += 2; continue; }
    if (text[index] !== opener[0]) { index++; continue; }
    let runLength = 0;
    while (text[index + runLength] === opener[0]) runLength++;
    // In *italic **bold*** the doubled run opens nested strong text; the
    // single marker closes the outer span at the end of the full run.
    if (opener === '*' && runLength === 2) { index += runLength; continue; }
    if (runLength >= opener.length) {
      // Consume the end of a delimiter run so nested emphasis can use the
      // preceding markers (for example *italic **bold***).
      const closeStart = index + Math.max(0, runLength - opener.length);
      const content = text.slice(contentStart, closeStart);
      if (content.trim() && !/\s$/u.test(content)) return { marker: opener, content, end: closeStart + opener.length };
    }
    index += runLength || 1;
  }
  return null;
}

function readMarkdownLink(text: string, start: number): { label: string; destination: string; end: number } | null {
  // Balanced delimiters support URLs such as /reference/function(name).
  const closingDelimiter = (offset: number, open: string, close: string): number => {
    let nesting = 1;
    for (let index = offset + 1; index < text.length; index++) {
      if (text[index] === '\\') { index++; continue; }
      if (text[index] === open) nesting++;
      if (text[index] === close && --nesting === 0) return index;
    }
    return -1;
  };
  const labelEnd = closingDelimiter(start, '[', ']');
  if (labelEnd < 0 || text[labelEnd + 1] !== '(') return null;
  const destinationEnd = closingDelimiter(labelEnd + 1, '(', ')');
  if (destinationEnd < 0) return null;
  let destination = text.slice(labelEnd + 2, destinationEnd).trim();
  if (destination.startsWith('<') && destination.endsWith('>')) destination = destination.slice(1, -1);
  return { label: text.slice(start + 1, labelEnd), destination, end: destinationEnd + 1 };
}

function safeMarkdownHref(destination: string, baseUrl: string): string | null {
  // Reject browser-normalized control characters, backslash authorities, and
  // protocol-relative URLs before resolution. Never decode HTML entities here.
  if (/[\s\u0000-\u001f\u007f-\u009f\\]/u.test(destination) || destination.startsWith('//')) return null;
  let decodedDestination = destination;
  try {
    decodedDestination = decodeURIComponent(destination);
  } catch {
    return null;
  }
  if (/[\s\u0000-\u001f\u007f-\u009f\\]/u.test(decodedDestination) || decodedDestination.startsWith('//')) return null;
  const entityDecodedDestination = decodedDestination
    .replace(/&#(?:x([\da-f]+)|([\d]+));?/gi, (match, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&colon;?/gi, ':');
  if (/[\s\u0000-\u001f\u007f-\u009f\\]/u.test(entityDecodedDestination) || entityDecodedDestination.startsWith('//')) return null;
  const scheme = entityDecodedDestination.match(/^([a-z][a-z\d+.-]*):/i)?.[1].toLowerCase();
  if (scheme && !['http', 'https', 'mailto'].includes(scheme)) return null;
  try {
    const url = new URL(destination, baseUrl);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
    if (!scheme && url.origin !== new URL(baseUrl).origin) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character));
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
