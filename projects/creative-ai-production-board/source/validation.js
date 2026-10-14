/**
 * Pure validation and manifest helpers for the local production board.
 *
 * The board intentionally works on bundled data only. There are no network,
 * model, clock, or DOM dependencies here, so the same input always produces
 * the same validation result and manifest.
 */

const ALLOWED_RIGHTS_STATUSES = new Set(['cleared', 'editorial', 'ai-assisted']);
const CUE_ASSET_IDS = Object.freeze({
  'signal-hum': 'audio-hum',
  'voice-note-07': 'audio-voice',
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasAssetId(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function normalizeText(value) {
  return value === undefined || value === null
    ? ''
    : String(value).normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function normalizeCreditPart(value) {
  return normalizeText(value).toLowerCase();
}

function isValidCreditRecord(credit) {
  return isRecord(credit)
    && typeof credit.name === 'string'
    && normalizeText(credit.name)
    && typeof credit.role === 'string'
    && normalizeText(credit.role);
}

function creditIdentity(credit) {
  if (!isValidCreditRecord(credit)) return undefined;
  return JSON.stringify([normalizeCreditPart(credit.name), normalizeCreditPart(credit.role)]);
}

function creditId(credit) {
  return isValidCreditRecord(credit) && hasAssetId(credit.id) ? normalizeText(credit.id) : undefined;
}

function creditSceneIds(credit) {
  return Array.isArray(credit?.sceneIds) ? uniqueStrings(credit.sceneIds) : [];
}

function isValidTiming(scene) {
  return isRecord(scene)
    && typeof scene.start === 'number'
    && Number.isFinite(scene.start)
    && typeof scene.end === 'number'
    && Number.isFinite(scene.end)
    && scene.start >= 0
    && scene.end > scene.start;
}

function assetMap(assets) {
  return new Map(asArray(assets).filter(isRecord).map((asset) => [asset.id, asset]));
}

function sceneId(scene) {
  return isRecord(scene) && hasAssetId(scene.id) ? String(scene.id) : '';
}

function sceneIds(...scenes) {
  return [...new Set(scenes.flatMap((scene) => {
    const id = sceneId(scene);
    return id ? [id] : [];
  }))];
}

function sceneDescription(scene) {
  if (!isRecord(scene)) return 'scene record';
  const parts = [];
  if (hasAssetId(scene.id)) parts.push(`id "${scene.id}"`);
  if (hasAssetId(scene.number)) parts.push(`number "${scene.number}"`);
  if (normalizeText(scene.title)) parts.push(`title "${normalizeText(scene.title)}"`);
  return parts.length ? `scene (${parts.join(', ')})` : 'unnamed scene';
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null).map(String))];
}

function makeIssue(code, severity, message, relatedScenes = [], assetId) {
  const issue = {
    code,
    severity,
    message,
    sceneIds: uniqueStrings(relatedScenes),
  };
  if (hasAssetId(assetId)) issue.assetId = assetId;
  return issue;
}

function hasActualCueReference(scene) {
  if (!isRecord(scene)) return false;
  return hasAssetId(scene.cueAssetId) || hasAssetId(scene.cue);
}

function hasCueAssetReference(scene) {
  if (!isRecord(scene)) return false;
  // A silent scene may carry an empty optional field from a form serializer,
  // but any actual cue reference is a conflict and must still be checked.
  return scene.silent !== true || hasActualCueReference(scene);
}

/** Resolve explicit IDs first, then the small legacy cue-name map. */
export function resolveCueAssetId(scene) {
  if (!isRecord(scene)) return undefined;
  if (Object.prototype.hasOwnProperty.call(scene, 'cueAssetId')) {
    return scene.cueAssetId;
  }

  const cue = normalizeText(scene.cue);
  if (!cue) return undefined;
  return Object.prototype.hasOwnProperty.call(CUE_ASSET_IDS, cue) ? CUE_ASSET_IDS[cue] : cue;
}

function sceneReferences(scenes) {
  return asArray(scenes).flatMap((scene) => {
    const references = [{ scene, kind: 'frame', assetId: isRecord(scene) ? scene.assetId : undefined }];
    if (hasCueAssetReference(scene)) {
      references.push({ scene, kind: 'audio-cue', assetId: resolveCueAssetId(scene) });
    }
    return references;
  });
}

function findMissingCueScenes(scenes = [], assets = []) {
  const available = new Set(asArray(assets).filter(isRecord).map((asset) => asset.id));
  return asArray(scenes).filter((scene) => {
    if (!isRecord(scene)) return false;
    const actualReference = hasActualCueReference(scene);
    if (scene.silent === true) return actualReference;
    if (!actualReference) return true;
    const cueAssetId = resolveCueAssetId(scene);
    return !hasAssetId(cueAssetId) || !available.has(cueAssetId);
  });
}

export function findMissingAssets(scenes = [], assets = []) {
  const available = new Set(asArray(assets).filter(isRecord).map((asset) => asset.id));
  return asArray(scenes).filter((scene) => sceneReferences([scene]).some(({ assetId }) => (
    !hasAssetId(assetId) || !available.has(assetId)
  )));
}

export function findDuplicateCredits(credits = []) {
  const seen = new Map();
  const seenIds = new Map();
  const duplicates = [];

  asArray(credits).forEach((credit) => {
    // Invalid records are reported by `invalidCredits`; they must not also
    // become a misleading duplicate of every other blank record.
    if (!isValidCreditRecord(credit)) return;
    const id = creditId(credit);
    const key = creditIdentity(credit);
    const firstById = id ? seenIds.get(id) : undefined;
    // A stable credit ID means this is the same person/role being referenced
    // by another shared scene. It is intentionally merged, not rejected.
    if (firstById && creditIdentity(firstById) === key) return;
    if (id && firstById && creditIdentity(firstById) !== key) {
      duplicates.push({ credit, first: firstById, reason: `credit id "${id}" maps to different names or roles` });
      return;
    }
    if (seen.has(key)) {
      duplicates.push({ credit, first: seen.get(key) });
    } else {
      seen.set(key, credit);
    }
    if (id) seenIds.set(id, credit);
  });

  return duplicates;
}

/**
 * Collapse repeated stable credit references for a manifest. Credits without
 * a stable ID remain keyed by normalized name/role; validation still blocks
 * ambiguous duplicate records before this helper is used for export.
 */
export function deduplicateCredits(credits = []) {
  const merged = new Map();
  asArray(credits).forEach((credit) => {
    if (!isValidCreditRecord(credit)) return;
    const key = creditId(credit) ? `id:${creditId(credit)}` : `identity:${creditIdentity(credit)}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...credit });
      return;
    }
    const sceneIds = uniqueStrings([...creditSceneIds(existing), ...creditSceneIds(credit)]);
    if (sceneIds.length) existing.sceneIds = sceneIds;
  });
  return [...merged.values()];
}

export function findTimingOverlaps(scenes = []) {
  const ordered = asArray(scenes)
    .filter(isValidTiming)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const overlaps = [];

  // Compare every later scene, rather than only adjacent scenes. This catches
  // an inner scene that is completely contained by a longer outer scene.
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      const previous = ordered[left];
      const current = ordered[right];
      if (current.start >= previous.end) break;
      overlaps.push({
        previous,
        current,
        overlap: Math.min(previous.end, current.end) - Math.max(previous.start, current.start),
      });
    }
  }

  return overlaps;
}

export function findInvalidTimings(scenes = []) {
  return asArray(scenes).filter((scene) => !isValidTiming(scene));
}

export function findOutOfOrderScenes(scenes = []) {
  const outOfOrder = [];
  let previous;
  asArray(scenes).filter(isValidTiming).forEach((current) => {
    if (previous && current.start < previous.start) {
      outOfOrder.push({ previous, current });
    }
    previous = current;
  });
  return outOfOrder;
}

function deriveDuration(scenes) {
  return asArray(scenes)
    .filter((scene) => isRecord(scene) && typeof scene.end === 'number' && Number.isFinite(scene.end))
    .reduce((maximum, scene) => Math.max(maximum, scene.end), 0);
}

function timingGapDetails(scenes, duration) {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return [];
  const ordered = asArray(scenes)
    .filter(isValidTiming)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  if (!ordered.length) return [];

  const gaps = [];
  let coverageEnd = 0;
  let coverageScene;
  const addGap = (start, end, nextScene) => {
    if (end <= start) return;
    gaps.push({
      gap: { start, end, duration: end - start },
      sceneIds: sceneIds(coverageScene, nextScene),
    });
  };

  if (ordered[0].start > 0) addGap(0, ordered[0].start, ordered[0]);
  coverageEnd = ordered[0].end;
  coverageScene = ordered[0];

  ordered.slice(1).forEach((scene) => {
    if (scene.start > coverageEnd) addGap(coverageEnd, scene.start, scene);
    if (scene.end > coverageEnd) {
      coverageEnd = scene.end;
      coverageScene = scene;
    }
  });
  if (duration > coverageEnd) addGap(coverageEnd, duration);
  return gaps;
}

export function findTimingGaps(scenes = [], duration = deriveDuration(scenes)) {
  return timingGapDetails(scenes, duration).map(({ gap }) => gap);
}

function findUnclearedAssetReferences(scenes = [], assets = []) {
  const byId = assetMap(assets);
  return sceneReferences(scenes)
    .map(({ scene, kind, assetId }) => ({ scene, kind, asset: byId.get(assetId), assetId }))
    .filter(({ asset }) => !asset || !ALLOWED_RIGHTS_STATUSES.has(normalizeText(asset.rightsStatus).toLowerCase()));
}

export function findUnclearedAssets(scenes = [], assets = []) {
  // Preserve the original public result shape used by app.js and callers.
  return findUnclearedAssetReferences(scenes, assets)
    .map(({ scene, asset }) => ({ scene, asset }));
}

function findEditorialAssets(scenes, assets) {
  const byId = assetMap(assets);
  const found = new Map();

  sceneReferences(scenes).forEach(({ assetId }) => {
    const asset = byId.get(assetId);
    if (asset && normalizeText(asset.rightsStatus).toLowerCase() === 'editorial') {
      found.set(asset.id, asset);
    }
  });

  return [...found.values()];
}

function referencesForAsset(references, assetId) {
  return references.filter((reference) => reference.assetId === assetId);
}

function parseCueTime(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+):([0-5]\d(?:\.\d+)?)$/u.exec(value.trim());
  if (!match) return undefined;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(seconds) ? seconds : undefined;
}

export function formatCueTime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return formatSeconds(seconds);
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const whole = wholeSeconds % 60;
  // Preserve the decimal from the original timestamp instead of rounding it
  // down to an entry outside a fractional scene boundary.
  const [coefficient, exponent = '0'] = String(seconds).split('e');
  const [integer, decimal = ''] = coefficient.split('.');
  const digits = integer + decimal;
  const decimalIndex = integer.length + Number(exponent);
  const fractionText = decimalIndex <= 0
    ? `${'0'.repeat(-decimalIndex)}${digits}`
    : decimalIndex < digits.length ? digits.slice(decimalIndex) : '';
  return `${minutes.toString().padStart(2, '0')}:${whole.toString().padStart(2, '0')}${fractionText ? `.${fractionText}` : ''}`;
}

/** Explicit reorder operation: preserve scene lengths and valid cue offsets.
 * Invalid cues remain invalid instead of silently concealing production issues.
 */
export function reflowScenes(scenes) {
  if (!Array.isArray(scenes) || scenes.some((scene) => !isValidTiming(scene))) {
    throw new Error('Fix invalid scene durations before reordering the cut');
  }
  let cursor = 0;
  return scenes.map((scene) => {
    const duration = scene.end - scene.start;
    const entry = parseCueTime(scene.cueTime);
    const next = { ...scene, start: cursor, end: cursor + duration };
    if (scene.silent !== true && entry !== undefined && entry >= scene.start && entry < scene.end) {
      next.cueTime = formatCueTime(cursor + (entry - scene.start));
    }
    cursor = next.end;
    return next;
  });
}

function durationProblems(duration, scenes) {
  const requiredDuration = deriveDuration(scenes);
  if (duration === undefined) return { value: requiredDuration, issues: [] };
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    return {
      value: undefined,
      issues: [{ duration, requiredDuration, reason: 'duration must be a finite number' }],
    };
  }
  if (duration < 0) {
    return {
      value: undefined,
      issues: [{ duration, requiredDuration, reason: 'duration cannot be negative' }],
    };
  }
  if (duration < requiredDuration) {
    return {
      value: duration,
      issues: [{ duration, requiredDuration, reason: `duration must cover every scene through ${requiredDuration} seconds` }],
    };
  }
  return { value: duration, issues: [] };
}

function isPublicDistribution(settings) {
  return settings.publicDistribution === true
    || settings.distribution === 'public'
    || settings.distribution === 'public-distribution';
}

function isSettingsBlocker(message) {
  return /^(Export settings|Distribution must|Export cannot include uncleared assets|Resolve production issues|Rights labels must be embedded|includeUncleared|allowUnresolved|embedRightsLabels|publicDistribution)/u.test(message)
    || /must be a boolean$/u.test(message);
}

export function validateProduction(input = {}) {
  const objectInput = isRecord(input);
  const scenesValue = objectInput && input.scenes !== undefined ? input.scenes : [];
  const assetsValue = objectInput && input.assets !== undefined ? input.assets : [];
  const creditsValue = objectInput && input.credits !== undefined ? input.credits : [];
  const exportSettings = objectInput && input.exportSettings !== undefined ? input.exportSettings : {};
  const duration = objectInput ? input.duration : undefined;
  const scenes = asArray(scenesValue);
  const assets = asArray(assetsValue);
  const credits = asArray(creditsValue);
  const missingAssets = findMissingAssets(scenes, assets);
  const missingCues = findMissingCueScenes(scenes, assets);
  const duplicateCredits = findDuplicateCredits(credits);
  const timingOverlaps = findTimingOverlaps(scenes);
  const invalidTimings = findInvalidTimings(scenes);
  const outOfOrder = findOutOfOrderScenes(scenes);
  const durationResult = durationProblems(duration, scenes);
  const timingGapDetailsResult = timingGapDetails(scenes, durationResult.value ?? deriveDuration(scenes));
  const timingGaps = timingGapDetailsResult.map(({ gap }) => gap);
  const unclearedAssetReferences = findUnclearedAssetReferences(scenes, assets);
  const unclearedAssets = unclearedAssetReferences.map(({ scene, asset }) => ({ scene, asset }));
  const editorialAssets = findEditorialAssets(scenes, assets);
  const byId = assetMap(assets);
  const references = sceneReferences(scenes);
  const invalidAssetTypes = references
    .map((reference) => ({ ...reference, asset: byId.get(reference.assetId) }))
    .filter(({ kind, asset }) => asset && asset.type !== (kind === 'audio-cue' ? 'AUDIO' : 'FRAME'));
  const missingRightsLabels = [...new Set(references.map(({ assetId }) => byId.get(assetId)))]
    .filter((asset) => asset && (typeof asset.rightsLabel !== 'string' || !asset.rightsLabel.trim()));
  const invalidCredits = asArray(creditsValue).filter((credit) => !isRecord(credit)
    || typeof credit.name !== 'string' || !normalizeText(credit.name)
    || typeof credit.role !== 'string' || !normalizeText(credit.role));
  const cueTimingIssues = [];
  const issues = [];
  const errors = [];
  const warnings = [];
  const addIssue = (code, severity, message, relatedScenes = [], assetId) => {
    issues.push(makeIssue(code, severity, message, relatedScenes, assetId));
  };
  const addError = (message, code) => {
    errors.push(message);
    if (code) addIssue(code, 'error', message);
  };

  if (!objectInput) addError('Production input must be an object', 'invalid-production');
  if (![scenesValue, assetsValue, creditsValue].every(Array.isArray)) {
    addError('Scenes, assets, and credits must be arrays', 'invalid-production');
  }
  if (scenes.length === 0) addError('A cut must contain at least one scene', 'empty-cut');

  const assetIds = new Set();
  asArray(assetsValue).forEach((asset) => {
    if (!isRecord(asset) || !hasAssetId(asset.id)) {
      addError('Assets must have a non-empty id', 'invalid-asset');
    } else if (assetIds.has(asset.id)) {
      addError(`Duplicate asset id: ${asset.id}`, 'duplicate-asset');
    } else {
      assetIds.add(asset.id);
    }
  });

  scenes.forEach((scene) => {
    if (!isRecord(scene)) return;
    const frameAsset = byId.get(scene.assetId);
    if (!hasAssetId(scene.assetId) || !frameAsset) {
      const detail = `${sceneDescription(scene)} is missing frame asset ${hasAssetId(scene.assetId) ? `"${scene.assetId}"` : '(blank)'}`;
      addIssue('missing-frame', 'error', detail, sceneIds(scene), scene.assetId);
    }

    const actualCue = hasActualCueReference(scene);
    const cueAssetId = resolveCueAssetId(scene);
    if (missingCues.includes(scene)) {
      const message = scene.silent === true && actualCue
        ? `${sceneDescription(scene)} is marked silent but references audio cue "${hasAssetId(scene.cueAssetId) ? scene.cueAssetId : scene.cue}"; remove the reference or set silent:false`
        : !actualCue
          ? `${sceneDescription(scene)} has no audio cue; set silent:true to declare intentional silence`
          : `${sceneDescription(scene)} references unresolved audio cue asset ${hasAssetId(cueAssetId) ? `"${cueAssetId}"` : '(blank explicit cueAssetId overrides the legacy cue)'}; link an available AUDIO asset or declare intentional silence`;
      addIssue('missing-cue', 'error', message, sceneIds(scene), cueAssetId);
    }

    if (Object.prototype.hasOwnProperty.call(scene, 'cueTime') && scene.cueTime !== undefined) {
      const parsed = parseCueTime(scene.cueTime);
      let reason = '';
      if (parsed === undefined) {
        reason = 'cue time must use MM:SS with seconds from 00 through 59 and an optional fractional part';
      } else if (!isValidTiming(scene) || parsed < scene.start || parsed >= scene.end) {
        reason = `cue time must fall within [${scene.start}, ${scene.end}) seconds`;
      }
      if (reason) {
        const entry = { scene, cueTime: scene.cueTime, parsedSeconds: parsed, reason };
        cueTimingIssues.push(entry);
        addIssue('cue-timing', 'error', `${sceneDescription(scene)} has invalid cue time "${scene.cueTime}"${hasAssetId(cueAssetId) ? ` for audio cue asset "${cueAssetId}"` : ''}: ${reason}`, sceneIds(scene), cueAssetId);
      }
    }
  });

  if (missingAssets.length) {
    addError(`${missingAssets.length} scene${missingAssets.length === 1 ? '' : 's'} reference missing assets (frame or audio cue)`);
  }
  if (missingCues.length) {
    addError(`${missingCues.length} scene${missingCues.length === 1 ? '' : 's'} have a missing or unresolved audio cue`);
  }
  if (duplicateCredits.length) {
    addError(`${duplicateCredits.length} duplicate credit${duplicateCredits.length === 1 ? '' : 's'} found`);
    duplicateCredits.forEach(({ credit, first }) => {
      addIssue('duplicate-credit', 'error', `Duplicate credit "${normalizeText(credit?.name)}" / "${normalizeText(credit?.role)}" repeats "${normalizeText(first?.name)}" / "${normalizeText(first?.role)}"`, []);
    });
  }
  timingOverlaps.forEach(({ previous, current, overlap }) => {
    addIssue('timing-overlap', 'error', `${sceneDescription(previous)} overlaps ${sceneDescription(current)} by ${overlap} seconds`, sceneIds(previous, current));
  });
  if (timingOverlaps.length) {
    addError(`${timingOverlaps.length} timing overlap${timingOverlaps.length === 1 ? '' : 's'} found`);
  }
  invalidTimings.forEach((scene) => {
    addIssue('invalid-timing', 'error', `${sceneDescription(scene)} has invalid timing (start=${String(scene?.start)}, end=${String(scene?.end)}); start must be finite and non-negative and end must be finite and greater than start`, sceneIds(scene));
  });
  if (invalidTimings.length) {
    addError(`${invalidTimings.length} scene${invalidTimings.length === 1 ? '' : 's'} have invalid timing (finite, non-negative start and end > start required)`);
  }
  outOfOrder.forEach(({ previous, current }) => {
    addIssue('scene-order', 'error', `${sceneDescription(current)} appears after ${sceneDescription(previous)} in the array but starts earlier (${current.start} < ${previous.start})`, sceneIds(previous, current));
  });
  if (outOfOrder.length) {
    addError(`${outOfOrder.length} scene${outOfOrder.length === 1 ? '' : 's'} are out of timestamp order`);
  }
  if (cueTimingIssues.length) {
    addError(`${cueTimingIssues.length} scene${cueTimingIssues.length === 1 ? '' : 's'} have invalid cue time entries`);
  }
  durationResult.issues.forEach((durationIssue) => {
    const affected = scenes.filter((scene) => isValidTiming(scene)
      && (typeof durationIssue.duration !== 'number' || !Number.isFinite(durationIssue.duration)
        || scene.end > durationIssue.duration));
    const detail = durationIssue.reason === 'duration cannot be negative'
      ? `Declared cut duration ${durationIssue.duration} is negative; it must be at least ${durationIssue.requiredDuration} seconds`
      : durationIssue.reason.startsWith('duration must cover')
        ? `Declared cut duration ${durationIssue.duration} is shorter than ${durationIssue.requiredDuration}; it must cover every scene end`
        : `Declared cut duration must be a finite number; received ${String(durationIssue.duration)}`;
    const message = `${detail}${affected.length ? ` (${affected.map(sceneDescription).join('; ')})` : ''}`;
    addIssue('invalid-timing', 'error', message, sceneIds(...affected));
    addError(message);
  });

  if (invalidAssetTypes.length) {
    addError('Scene assets must be FRAME and audio cue assets must be AUDIO');
    invalidAssetTypes.forEach(({ scene, kind, asset, assetId }) => {
      addIssue('asset-type', 'error', `${sceneDescription(scene)} references ${kind === 'audio-cue' ? 'audio cue' : 'frame'} asset "${assetId}" with type ${asset.type}`, sceneIds(scene), assetId);
    });
  }
  if (missingRightsLabels.length) addError('Referenced assets must have rights labels');
  missingRightsLabels.forEach((asset) => {
    const related = referencesForAsset(references, asset.id).map(({ scene }) => scene);
    addIssue('rights-label', 'error', `Referenced asset "${asset.id}" is missing a rights label for ${related.map(sceneDescription).join('; ')}`, sceneIds(...related), asset.id);
  });
  if (invalidCredits.length) addError('Credits must have a non-empty name and role');
  invalidCredits.forEach((credit) => {
    const name = isRecord(credit) ? normalizeText(credit.name) : '';
    const role = isRecord(credit) ? normalizeText(credit.role) : '';
    addIssue('invalid-credit', 'error', `Credit records must have a non-empty string name and role; received name "${name}" and role "${role}"`, []);
  });

  timingGapDetailsResult.forEach(({ gap, sceneIds: relatedSceneIds }) => {
    const related = scenes.filter((scene) => relatedSceneIds.includes(sceneId(scene)));
    const message = `Timing gap from ${gap.start} to ${gap.end} seconds (${gap.duration} seconds)${related.length ? ` near ${related.map(sceneDescription).join('; ')}` : ''}`;
    warnings.push(message);
    addIssue('timing-gap', 'warning', message, relatedSceneIds);
  });

  if (unclearedAssets.length) {
    warnings.push(`${unclearedAssets.length} asset${unclearedAssets.length === 1 ? '' : 's'} need rights review`);
  }
  unclearedAssetReferences.forEach(({ scene, asset, assetId }) => {
    if (asset) {
      addIssue('rights-clearance', 'error', `${sceneDescription(scene)} references asset "${assetId}" with rights status "${normalizeText(asset.rightsStatus) || 'missing'}"; clear it before export`, sceneIds(scene), assetId);
    }
  });

  const publicDistribution = isPublicDistribution(isRecord(exportSettings) ? exportSettings : {});
  if (editorialAssets.length) {
    warnings.push('Editorial-only assets are permitted for internal review, not public distribution');
    editorialAssets.forEach((asset) => {
      const related = referencesForAsset(references, asset.id).map(({ scene }) => scene);
      const severity = publicDistribution ? 'error' : 'warning';
      const message = `Editorial-only asset "${asset.id}" used by ${related.map(sceneDescription).join('; ')} is limited to internal-review exports${publicDistribution ? ' and cannot be used for public distribution' : ''}`;
      addIssue('editorial-rights', severity, message, sceneIds(...related), asset.id);
    });
  }

  const preliminary = {
    errors,
    warnings,
    issues,
    missingAssets,
    duplicateCredits,
    timingOverlaps,
    invalidTimings,
    outOfOrder,
    missingCues,
    cueTimingIssues,
    durationIssues: durationResult.issues,
    unclearedAssets,
    editorialAssets,
    invalidAssetTypes,
    missingRightsLabels,
    invalidCredits,
  };
  const safety = checkExportSafety(exportSettings, preliminary);
  safety.blockers.filter(isSettingsBlocker).forEach((message) => {
    addIssue('unsafe-setting', 'error', message, []);
  });

  return {
    ok: errors.length === 0 && safety.blockers.length === 0,
    errors,
    warnings,
    safety,
    issues,
    timingGaps,
    outOfOrder,
    missingCues,
    cueTimingIssues,
    durationIssues: durationResult.issues,
    missingAssets,
    duplicateCredits,
    timingOverlaps,
    invalidTimings,
    unclearedAssets,
    editorialAssets,
    invalidAssetTypes,
    missingRightsLabels,
    invalidCredits,
    duration: durationResult.value,
  };
}

/** Validate a cut while keeping the shared production validation path. */
export function validateCut(input = {}) {
  if (!isRecord(input)) return validateProduction(input);
  const { cut, assets = [], credits = [], exportSettings = {} } = input;
  const cutRecord = isRecord(cut) ? cut : {};
  return validateProduction({
    scenes: cutRecord.scenes,
    duration: cutRecord.duration,
    assets,
    credits,
    exportSettings,
  });
}

export function checkExportSafety(settings = {}, validation = {}) {
  const blockers = [];
  const notices = [];

  if (!isRecord(settings)) {
    blockers.push('Export settings must be an object');
    settings = {};
  }
  if (!isRecord(validation)) {
    blockers.push('Production validation must be an object');
    validation = {};
  }
  for (const flag of ['includeUncleared', 'allowUnresolved', 'embedRightsLabels', 'publicDistribution']) {
    if (settings[flag] !== undefined && typeof settings[flag] !== 'boolean') {
      blockers.push(`${flag} must be a boolean`);
    }
  }
  if (settings.distribution !== undefined
    && !['internal-review', 'public', 'public-distribution'].includes(settings.distribution)) {
    blockers.push('Distribution must be internal-review or public');
  }
  if (settings.includeUncleared) {
    blockers.push('Export cannot include uncleared assets; set includeUncleared:false and clear all referenced assets');
  }
  if (settings.allowUnresolved) {
    blockers.push('Resolve production issues before export and set allowUnresolved:false');
  }
  if (settings.embedRightsLabels === false) {
    blockers.push('Rights labels must be embedded in the manifest; set embedRightsLabels:true');
  }
  // Re-evaluate settings and distribution here. Structured results distinguish
  // settings failures from production failures; a stale `ok:false` by itself
  // remains fail-closed for legacy callers that cannot supply that distinction.
  const productionErrorIssues = asArray(validation.issues).filter((issue) => (
    issue?.severity === 'error'
    && issue.code !== 'unsafe-setting'
    && (issue.code !== 'editorial-rights' || isPublicDistribution(settings))
  ));
  const hasErrorIssues = productionErrorIssues.length > 0;
  const hasProductionIssues = ['errors', 'missingAssets', 'duplicateCredits', 'timingOverlaps',
    'invalidTimings', 'outOfOrder', 'missingCues', 'cueTimingIssues', 'durationIssues',
    'invalidAssetTypes', 'missingRightsLabels', 'invalidCredits']
    .some((key) => validation[key]?.length) || hasErrorIssues;
  const explainedSettingsFailure = asArray(validation.issues).some((issue) => (
    issue?.severity === 'error'
    && (issue.code === 'unsafe-setting'
      || (issue.code === 'editorial-rights' && !isPublicDistribution(settings)))
  ));
  const unexplainedFailure = validation.ok === false && !explainedSettingsFailure;
  if (hasProductionIssues || unexplainedFailure) {
    const productionMessages = [
      ...(Array.isArray(validation.errors) ? validation.errors : []),
      ...productionErrorIssues.map((issue) => issue.message),
    ];
    [...new Set(productionMessages)].forEach((message) => blockers.push(`Production issue: ${message}`));
    blockers.push('Manifest has blocking production checks');
  }
  if (validation.unclearedAssets?.length) {
    blockers.push('Referenced assets need rights clearance before export');
  }
  if (validation.editorialAssets?.length) {
    if (isPublicDistribution(settings)) {
      blockers.push('Editorial-only assets cannot be exported for public distribution');
    } else {
      notices.push('Editorial-only assets are limited to internal-review use');
    }
  }

  return { safe: blockers.length === 0, blockers, notices };
}

function referencedAssetIds(scenes) {
  return new Set(sceneReferences(scenes).map(({ assetId }) => assetId).filter(hasAssetId));
}

function rightsLabelRecords(scenes, assets) {
  const byId = assetMap(assets);
  return [...referencedAssetIds(scenes)].map((assetId) => {
    const asset = byId.get(assetId);
    return {
      assetId,
      type: asset?.type ?? null,
      label: typeof asset?.rightsLabel === 'string' && asset.rightsLabel.trim() ? asset.rightsLabel : null,
      status: asset?.rightsStatus ?? 'missing',
    };
  });
}

function alternateCutEntries(alternateCuts) {
  if (Array.isArray(alternateCuts)) {
    return alternateCuts.flatMap((entry) => {
      if (!isRecord(entry) || !isRecord(entry.cut)) return [];
      return [{ key: hasAssetId(entry.key) ? String(entry.key) : '', cut: entry.cut }];
    });
  }
  if (isRecord(alternateCuts)) {
    return Object.entries(alternateCuts).flatMap(([key, cut]) => (
      isRecord(cut) ? [{ key, cut }] : []
    ));
  }
  return [];
}

function alternateCutReport(entry, assets, credits, settings) {
  const validation = validateCut({ cut: entry.cut, assets, credits, exportSettings: settings });
  const warningIssues = validation.issues.filter((issue) => issue.severity === 'warning');
  const blockingIssues = validation.issues.filter((issue) => issue.severity === 'error');
  const issues = [...validation.issues];
  return {
    key: entry.key,
    label: entry.cut.label ?? entry.key,
    status: validation.ok ? (warningIssues.length ? 'review' : 'pass') : 'blocked',
    duration: validation.duration,
    timing: {
      duration: validation.duration,
      scenes: asArray(entry.cut.scenes).map((scene) => ({ id: scene.id, start: scene.start, end: scene.end })),
      gaps: validation.timingGaps,
    },
    warnings: warningIssues,
    blockingIssues,
    issues,
    rightsLabels: rightsLabelRecords(entry.cut.scenes, assets),
    validation: {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
      safety: validation.safety,
    },
  };
}

/**
 * Build a detached, reproducible handoff; only assets referenced by this cut
 * travel with it. `distribution` defaults to `internal-review`; `public`
 * (also `public-distribution` or `publicDistribution: true`) disallows editorial
 * frames and cues. An explicit cueAssetId always overrides the legacy cue map.
 */
export function buildManifest(input = {}) {
  if (!isRecord(input)) throw new TypeError('Manifest input must be an object');
  const {
    project, cutKey, cut, assets = [], credits = [], settings = {}, alternateCuts = [],
  } = input;
  if (!isRecord(cut) || !Array.isArray(cut.scenes) || cut.scenes.length === 0) {
    throw new Error('Cannot export manifest: a cut with scenes is required');
  }
  if (!(typeof project === 'string' && project.trim()) && !isRecord(project)) {
    throw new Error('Cannot export manifest: project metadata is required');
  }
  if (!hasAssetId(cutKey)) throw new Error('Cannot export manifest: cutKey is required');

  // Revalidate from current inputs on every call so a prior failed check never
  // poisons a later export after settings or board data are corrected.
  const validation = validateCut({ cut, assets, credits, exportSettings: settings });
  if (!validation.ok) {
    const reasons = [...new Set([
      ...validation.errors,
      ...validation.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message),
      ...validation.safety.blockers,
    ])];
    throw new Error(`Cannot export unsafe manifest: ${reasons.join('; ')}`);
  }

  const duration = validation.duration;
  const byId = assetMap(assets);
  const usedIds = referencedAssetIds(cut.scenes);
  const exportSettings = {
    ...(isRecord(settings) ? settings : {}),
    distribution: isPublicDistribution(isRecord(settings) ? settings : {}) ? 'public' : 'internal-review',
    embedRightsLabels: true,
    includeUncleared: false,
    allowUnresolved: false,
  };
  const warningIssues = validation.issues.filter((issue) => issue.severity === 'warning');
  const continuity = {
    status: warningIssues.length ? 'review' : 'pass',
    issues: warningIssues,
    timingGaps: validation.timingGaps,
  };
  const scenes = cut.scenes.map((scene) => {
    const frame = byId.get(scene.assetId);
    const cueAssetId = resolveCueAssetId(scene);
    const audio = hasCueAssetReference(scene) ? byId.get(cueAssetId) : undefined;
    const sceneHasTimingWarnings = validation.timingGaps.some((gap) => (
      gap.end === scene.start || gap.start === scene.end
    ));
    const timingStatus = sceneHasTimingWarnings ? 'review' : 'pass';
    return {
      ...scene,
      // The source continuity label is editorial metadata. Export status is
      // computed from the fresh validation result instead.
      continuity: timingStatus,
      timingStatus,
      rightsStatus: frame.rightsStatus,
      rightsLabel: frame.rightsLabel,
      ...(audio ? {
        cueAssetId,
        audioCue: {
          cue: scene.cue ?? null,
          assetId: audio.id,
          name: audio.name,
          type: audio.type,
          label: scene.cueLabel ?? null,
          time: scene.cueTime === undefined ? formatCueTime(scene.start) : scene.cueTime,
          start: scene.start,
          end: scene.end,
          rightsStatus: audio.rightsStatus,
          rightsLabel: audio.rightsLabel,
        },
      } : { audioCue: null }),
    };
  });

  const alternateReports = alternateCutEntries(alternateCuts)
    .filter((entry) => entry.key !== String(cutKey))
    .map((entry) => alternateCutReport(entry, assets, credits, settings));
  const alternateCutWarnings = alternateReports
    .filter((report) => report.warnings.length || report.blockingIssues.length)
    .map((report) => ({
      key: report.key,
      label: report.label,
      status: report.status,
      warnings: report.warnings,
      blockingIssues: report.blockingIssues,
      timingGaps: report.timing.gaps,
      rightsLabels: report.rightsLabels,
    }));
  const activeRightsLabels = rightsLabelRecords(cut.scenes, assets);
  const safety = {
    safe: true,
    blockers: [],
    notices: validation.safety.notices,
  };

  // Clone JSON data, including nested project/credit metadata, so callers
  // cannot mutate the source board via a returned manifest (or vice versa).
  return JSON.parse(JSON.stringify({
    project,
    version: '1.0',
    localOnly: true,
    activeCut: cutKey,
    cut: cut.label ?? cutKey,
    duration,
    continuity,
    scenes,
    assets: assets.filter((asset) => usedIds.has(asset.id)),
    credits: deduplicateCredits(credits),
    rightsLabels: activeRightsLabels,
    alternateCuts: alternateReports,
    settings: exportSettings,
    safety,
    validation: {
      ok: true,
      warnings: validation.warnings,
      notices: validation.safety.notices,
      issues: validation.issues,
      alternateCutWarnings,
      rightsLabelsEmbedded: true,
      rightsLabels: activeRightsLabels,
      continuity,
    },
  }));
}

export function formatSeconds(seconds) {
  const total = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(total / 60).toString().padStart(2, '0');
  const remainder = (total % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}
