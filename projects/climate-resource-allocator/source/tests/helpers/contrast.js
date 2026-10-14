// Independent WCAG 2.x sRGB reference calculations; no application color code.
export function parseColor(value) {
  const color = value.trim().toLowerCase();
  if (color === 'transparent') return [0, 0, 0, 0];
  if (color === 'black') return [0, 0, 0, 1];
  if (color === 'white') return [255, 255, 255, 1];
  if (/^#[\da-f]{3,4}$/.test(color)) return parseColor(`#${[...color.slice(1)].map((c) => c + c).join('')}`);
  if (/^#[\da-f]{6}(?:[\da-f]{2})?$/.test(color)) {
    return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
      .concat(color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1);
  }
  const rgb = color.match(/^rgba?\((.*)\)$/);
  if (rgb) {
    const parts = rgb[1].split(/[\s,\/]+/).filter(Boolean);
    if (parts.length === 3 || parts.length === 4) {
      const channels = parts.slice(0, 3).map((part) => parseFloat(part) * (part.endsWith('%') ? 2.55 : 1));
      const alpha = parts[3] === undefined ? 1 : parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1);
      if ([...channels, alpha].every(Number.isFinite)) return [...channels, alpha];
    }
  }
  throw new Error(`Unsupported reference color: ${value}`);
}

export function relativeLuminance(value) {
  const channels = typeof value === 'string' ? parseColor(value) : value;
  const linear = channels.slice(0, 3).map((channel) => {
    const sRGB = channel / 255;
    return sRGB <= 0.04045 ? sRGB / 12.92 : ((sRGB + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function compositeOver(foreground, background) {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  return foreground.slice(0, 3).map((channel, index) =>
    (channel * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha).concat(alpha);
}

// Layers are nearest element first. Opacity applies to each composited group,
// including its background, rather than being mistaken for a text color alpha.
export function renderedColors({ color, layers }) {
  let foreground = parseColor(color);
  let background = [0, 0, 0, 0];
  for (const layer of layers) {
    const paint = parseColor(layer.background);
    foreground = compositeOver(foreground, paint);
    background = compositeOver(background, paint);
    foreground[3] *= layer.opacity;
    background[3] *= layer.opacity;
  }
  const canvas = [255, 255, 255, 1];
  return { foreground: compositeOver(foreground, canvas), background: compositeOver(background, canvas) };
}

export function parseTokens(css) {
  const tokens = new Map([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)]
    .map(([, name, value]) => [name, value.trim()]));
  function resolve(name, seen = new Set()) {
    if (seen.has(name)) throw new Error(`Circular CSS token: ${name}`);
    if (!tokens.has(name)) throw new Error(`Missing CSS token: ${name}`);
    const chain = new Set([...seen, name]);
    return tokens.get(name).replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, alias) => resolve(alias, chain));
  }
  return Object.fromEntries([...tokens.keys()].map((name) => [name, resolve(name)]));
}
