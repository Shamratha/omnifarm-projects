import { applyMask, getEffectiveVisibility } from './pipeline.js';

const images = new Map();
let generation = 0;

function loadImage(path) {
  if (!images.has(path)) {
    images.set(path, new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Cannot load ${path}`));
      image.src = path;
    }));
  }
  return images.get(path);
}

function surface(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// A local fixture preview, not an ICC engine: masks use the same pure pixel rule as the tests.
export async function renderPipelinePreview(documentState, target) {
  const ticket = ++generation;
  target.dataset.ready = 'false';
  const width = 800;
  const height = 500;
  const output = surface(width, height);
  const context = output.getContext('2d');
  const assets = new Map(documentState.assets.map((asset) => [asset.id, asset]));
  const skipped = [];
  for (const layer of structuredClone(documentState.layers)) {
    if (!getEffectiveVisibility(documentState, layer.id) || layer.type === 'text') continue;
    const canvas = surface(width, height);
    const layerContext = canvas.getContext('2d');
    if (layer.assetId) {
      const asset = assets.get(layer.assetId);
      if (!asset?.path) { skipped.push(layer.assetId); continue; }
      const image = await loadImage(asset.path);
      if (layer.id === 'grain') {
        layerContext.fillStyle = layerContext.createPattern(image, 'repeat');
        layerContext.fillRect(0, 0, width, height);
      } else layerContext.drawImage(image, 0, 0, width, height);
    } else if (layer.type === 'adjustment') {
      const { temperature = 0, tint = 0 } = layer.params ?? {};
      if (!temperature && !tint) continue;
      layerContext.fillStyle = `rgb(${128 + temperature * 3} ${128 - tint * 2} ${128 - temperature * 3})`;
      layerContext.fillRect(0, 0, width, height);
    } else continue;

    if (layer.mask?.enabled) {
      const asset = assets.get(layer.mask.assetId);
      if (!asset?.path) { skipped.push(layer.mask.assetId); continue; }
      const mask = surface(width, height);
      const maskContext = mask.getContext('2d');
      maskContext.filter = `blur(${Math.max(0, layer.mask.feather ?? 0) / 2}px)`;
      maskContext.drawImage(await loadImage(asset.path), 0, 0, width, height);
      const maskData = maskContext.getImageData(0, 0, width, height);
      const shift = (layer.mask.edgeShift ?? 0) * 2;
      for (let index = 0; index < maskData.data.length; index += 4) {
        maskData.data[index] = Math.max(0, Math.min(255, maskData.data[index] + shift));
      }
      const source = layerContext.getImageData(0, 0, width, height);
      const masked = applyMask({ width, height, pixels: source.data }, { width, height, pixels: maskData.data }, { invert: layer.mask.invert });
      source.data.set(masked.pixels);
      layerContext.putImageData(source, 0, 0);
    }
    context.globalAlpha = layer.opacity ?? 1;
    context.globalCompositeOperation = { Normal: 'source-over', 'Soft light': 'soft-light', Overlay: 'overlay', Multiply: 'multiply' }[layer.blendMode] ?? 'source-over';
    context.drawImage(canvas, 0, 0);
  }
  if (ticket !== generation) return;
  target.width = width;
  target.height = height;
  target.getContext('2d').drawImage(output, 0, 0);
  target.dataset.skippedAssets = skipped.join(',');
  target.dataset.ready = 'true';
}
