const ISSUE_ORDER = {
  BROKEN_REFERENCE: 0,
  MISSING_ASSET: 1,
  MISSING_MASK_ASSET: 2,
  UNSUPPORTED_PROFILE: 3,
  REFERENCE_CYCLE: 4
};

export const PROFILE_REGISTRY = Object.freeze({
  srgb: { label: "sRGB IEC61966-2.1", channels: "rgba" },
  displayP3: { label: "Display P3", channels: "rgba" },
  gray709: { label: "Rec. 709 grayscale", channels: "rgba" }
});

export function clone(value) {
  return structuredClone(value);
}

export function applyMask(image, mask, { invert = false } = {}) {
  if (image.width !== mask.width || image.height !== mask.height) {
    const error = new Error("Mask and image dimensions must match");
    error.code = "MASK_DIMENSION_MISMATCH";
    throw error;
  }
  const pixels = new Uint8Array(image.pixels);
  for (let index = 0; index < image.width * image.height; index += 1) {
    const maskValue = invert ? 255 - mask.pixels[index * 4] : mask.pixels[index * 4];
    pixels[index * 4 + 3] = Math.round(pixels[index * 4 + 3] * maskValue / 255);
  }
  return { ...image, pixels };
}

export function convertProfile(image, { sourceProfile = image.profile, targetProfile, profiles = PROFILE_REGISTRY } = {}) {
  if (!profiles[sourceProfile] || !profiles[targetProfile]) {
    const error = new Error("Unsupported color profile");
    error.code = "UNSUPPORTED_PROFILE";
    throw error;
  }
  if (sourceProfile === targetProfile) return { ...image, pixels: new Uint8Array(image.pixels) };
  const pixels = new Uint8Array(image.pixels);
  if (targetProfile === "gray709") {
    for (let index = 0; index < pixels.length; index += 4) {
      const gray = Math.round(0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]);
      pixels[index] = gray;
      pixels[index + 1] = gray;
      pixels[index + 2] = gray;
    }
  }
  return { ...image, profile: targetProfile, pixels };
}

export function getEffectiveVisibility(document, layerId) {
  const byId = new Map(document.layers.map((layer) => [layer.id, layer]));
  const visited = new Set();
  let layer = byId.get(layerId);
  while (layer) {
    if (visited.has(layer.id)) return false;
    visited.add(layer.id);
    if (layer.visible === false) return false;
    layer = layer.parentId ? byId.get(layer.parentId) : undefined;
  }
  return Boolean(byId.has(layerId));
}

export function getVisibleLayerIds(document) {
  return document.layers.filter((layer) => getEffectiveVisibility(document, layer.id)).map((layer) => layer.id);
}

export function validateDocument(document, { assets = document.assets ?? [], profiles = PROFILE_REGISTRY } = {}) {
  const assetIds = new Set((Array.isArray(assets) ? assets : [...assets.values()]).map((asset) => asset.id));
  const layerIds = new Set();
  const issues = [];
  const push = (issue) => issues.push(issue);

  document.layers.forEach((layer, index) => {
    if (layerIds.has(layer.id)) push({ code: "BROKEN_REFERENCE", severity: "error", path: `layers[${index}].id`, subjectId: layer.id, details: "Duplicate layer id" });
    layerIds.add(layer.id);
    if (layer.assetId && !assetIds.has(layer.assetId)) push({ code: "MISSING_ASSET", severity: "error", path: `layers[${index}].assetId`, subjectId: layer.id, details: { assetId: layer.assetId } });
    if (layer.mask?.assetId && !assetIds.has(layer.mask.assetId)) push({ code: "MISSING_MASK_ASSET", severity: "error", path: `layers[${index}].mask.assetId`, subjectId: layer.id, details: { assetId: layer.mask.assetId } });
    if (layer.parentId && !document.layers.some((candidate) => candidate.id === layer.parentId)) push({ code: "BROKEN_REFERENCE", severity: "error", path: `layers[${index}].parentId`, subjectId: layer.id, details: { parentId: layer.parentId } });
  });

  document.layers.forEach((layer) => {
    const path = new Set();
    let current = layer;
    while (current?.parentId) {
      if (path.has(current.id)) {
        push({ code: "REFERENCE_CYCLE", severity: "error", path: `layers[${layer.id}].parentId`, subjectId: layer.id });
        break;
      }
      path.add(current.id);
      current = document.layers.find((candidate) => candidate.id === current.parentId);
      if (!current) break;
    }
  });

  if (!profiles[document.canvas.profile]) push({ code: "UNSUPPORTED_PROFILE", severity: "error", path: "canvas.profile", subjectId: document.id, details: document.canvas.profile });
  issues.sort((a, b) => (ISSUE_ORDER[a.code] ?? 99) - (ISSUE_ORDER[b.code] ?? 99) || a.path.localeCompare(b.path) || a.subjectId.localeCompare(b.subjectId));
  return { valid: issues.length === 0, issues, statistics: { layerCount: document.layers.length, visibleLayerCount: getVisibleLayerIds(document).length, assetCount: assetIds.size } };
}

const BROKEN_REFERENCE_CODES = new Set(["BROKEN_REFERENCE", "MISSING_ASSET", "MISSING_MASK_ASSET", "REFERENCE_CYCLE"]);

export function summarizePipeline(document, { validation = validateDocument(document) } = {}) {
  const layers = new Map((document.layers ?? []).map((layer) => [layer.id, layer]));
  const operations = document.operations ?? [];
  const destructiveEdits = operations.flatMap((operation, index) => {
    if (operation.destructive !== true) return [];
    const subjectId = operation.subjectId ?? operation.layerId ?? document.id;
    const layer = layers.get(subjectId);
    return [{ ...operation, subjectId, path: operation.path ?? `operations[${index}]`, layerName: layer?.name ?? subjectId }];
  });
  const brokenReferences = (validation.issues ?? []).filter((issue) => BROKEN_REFERENCE_CODES.has(issue.code)).map((issue) => ({
    ...issue,
    layerName: layers.get(issue.subjectId)?.name ?? issue.subjectId
  }));
  return {
    destructiveEdits: { count: destructiveEdits.length, edits: destructiveEdits },
    brokenReferences: { count: brokenReferences.length, references: brokenReferences }
  };
}

function layerSignature(layer) {
  return JSON.stringify({ visible: layer.visible, opacity: layer.opacity, blendMode: layer.blendMode, assetId: layer.assetId, mask: layer.mask, params: layer.params, type: layer.type });
}

export function compareRevisions(before, after) {
  if (before.id !== after.id) {
    const error = new Error("Cannot compare unrelated documents");
    error.code = "DOCUMENT_ID_MISMATCH";
    throw error;
  }
  const changes = [];
  const beforeLayers = new Map(before.layers.map((layer) => [layer.id, layer]));
  const afterLayers = new Map(after.layers.map((layer) => [layer.id, layer]));
  after.layers.forEach((layer, index) => {
    if (!beforeLayers.has(layer.id)) changes.push({ type: "layer-added", path: `layers[${layer.id}]`, subjectId: layer.id, destructive: false });
    else if (before.layers.findIndex((candidate) => candidate.id === layer.id) !== index) changes.push({ type: "layer-reordered", path: `layers[${layer.id}]`, subjectId: layer.id, destructive: false });
  });
  before.layers.forEach((layer) => {
    if (!afterLayers.has(layer.id)) changes.push({ type: "layer-removed", path: `layers[${layer.id}]`, subjectId: layer.id, destructive: true });
  });
  after.layers.forEach((layer) => {
    const previous = beforeLayers.get(layer.id);
    if (previous && layerSignature(previous) !== layerSignature(layer)) changes.push({ type: "property-changed", path: `layers[${layer.id}]`, subjectId: layer.id, before: layerSignature(previous), after: layerSignature(layer), destructive: false });
  });
  if (before.canvas.profile !== after.canvas.profile) changes.push({ type: "profile-changed", path: "canvas.profile", subjectId: after.id, before: before.canvas.profile, after: after.canvas.profile, destructive: false });
  summarizePipeline(after).destructiveEdits.edits.forEach((operation) => changes.push(operation));
  changes.sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type));
  const destructiveChanges = changes.filter((change) => change.destructive);
  return { documentId: before.id, fromRevision: before.revision.id, toRevision: after.revision.id, changes, destructive: destructiveChanges.length > 0, destructiveChanges };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((result, key) => { result[key] = canonicalize(value[key]); return result; }, {});
  return value;
}

export function buildManifest(document, { validation = validateDocument(document), includeIssues = true } = {}) {
  const referencedAssetIds = new Set();
  document.layers.forEach((layer) => {
    if (layer.assetId) referencedAssetIds.add(layer.assetId);
    if (layer.mask?.assetId) referencedAssetIds.add(layer.mask.assetId);
  });
  return {
    schemaVersion: 1,
    documentId: document.id,
    revision: document.revision,
    canvas: document.canvas,
    layers: document.layers.map((layer) => ({ id: layer.id, name: layer.name, type: layer.type, visible: layer.visible, opacity: layer.opacity, blendMode: layer.blendMode, parentId: layer.parentId ?? null, assetId: layer.assetId ?? null, mask: layer.mask ?? null, params: layer.params ?? {} })),
    assets: [...referencedAssetIds].sort().map((id) => {
      const asset = document.assets.find((candidate) => candidate.id === id);
      return asset ? { ...asset, present: true } : { id, present: false, kind: "unresolved" };
    }),
    operations: document.operations ?? [],
    summary: summarizePipeline(document, { validation }),
    history: document.history,
    issues: includeIssues ? validation.issues : []
  };
}

export function exportManifest(document, options) {
  return `${JSON.stringify(canonicalize(buildManifest(document, options)), null, 2)}\n`;
}

export function createInspectorDocument() {
  return {
    id: "aurora-study",
    name: "Aurora study / poster-07",
    revision: { id: "rev-014", number: 14, parentId: "rev-013" },
    canvas: { width: 1600, height: 1000, profile: "displayP3", background: "#0c101a" },
    assets: [
      { id: "asset-background", name: "aurora-background.svg", path: "fixtures/aurora.svg", kind: "svg", profile: "displayP3", size: "3.4 KB" },
      { id: "asset-subject", name: "mountain-cutout.svg", path: "fixtures/mountain-cutout.svg", kind: "svg", profile: "displayP3", size: "2.1 KB" },
      { id: "asset-mask", name: "mountain-mask.svg", path: "fixtures/mountain-mask.svg", kind: "svg", profile: "gray709", size: "1.2 KB" },
      { id: "asset-grain", name: "grain-tile.svg", path: "fixtures/grain-tile.svg", kind: "svg", profile: "srgb", size: "0.8 KB" }
    ],
    layers: [
      { id: "background", name: "Aurora / base", type: "raster", visible: true, opacity: 1, blendMode: "Normal", assetId: "asset-background", accent: "violet", thumbnail: "aurora" },
      { id: "grade", name: "Color grade", type: "adjustment", visible: true, opacity: 0.82, blendMode: "Soft light", assetId: null, params: { temperature: -8, tint: 14 }, accent: "cyan", thumbnail: "grade" },
      { id: "mountain", name: "Mountain cutout", type: "vector", visible: true, opacity: 1, blendMode: "Normal", assetId: "asset-subject", mask: { assetId: "asset-mask", enabled: true, invert: false }, accent: "orange", thumbnail: "mountain" },
      { id: "grain", name: "Film grain", type: "raster", visible: false, opacity: 0.3, blendMode: "Overlay", assetId: "asset-grain", accent: "yellow", thumbnail: "grain" },
      { id: "caption", name: "Type / caption", type: "text", visible: true, opacity: 1, blendMode: "Normal", assetId: null, params: { text: "FIND THE LIGHT", tracking: 180 }, accent: "pink", thumbnail: "type" },
      { id: "broken", name: "Legacy texture", type: "raster", visible: true, opacity: 1, blendMode: "Normal", assetId: "asset-legacy-missing", accent: "red", thumbnail: "broken" }
    ],
    history: [
      { id: "evt-014", time: "14:32:08", label: "Adjusted color grade", detail: "Temperature -8 · Tint +14", kind: "adjustment" },
      { id: "evt-013", time: "14:28:46", label: "Enabled mountain mask", detail: "mountain-mask.svg", kind: "mask" },
      { id: "evt-012", time: "14:16:02", label: "Moved caption above grain", detail: "Non-destructive reorder", kind: "reorder" },
      { id: "evt-011", time: "13:52:19", label: "Imported mountain cutout", detail: "mountain-cutout.svg", kind: "import" }
    ],
    operations: []
  };
}
