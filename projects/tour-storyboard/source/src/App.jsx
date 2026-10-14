import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CirclePlay,
  Compass,
  Download,
  Eye,
  FileCode2,
  FileText,
  FolderOpen,
  GripVertical,
  Layers3,
  LocateFixed,
  Map as MapIcon,
  Maximize2,
  MousePointer2,
  Pause,
  Pencil,
  Play,
  Plus,
  Route,
  RotateCcw,
  Redo2,
  Save,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import RouteMap from './RouteMap';
import { initialTour, landmarks } from './data';
import {
  DEFAULT_CAMERA_ALTITUDE,
  cameraAtTime,
  captionInterval,
  routeDistanceMeters,
  sceneStartSeconds,
  sceneAtTime,
  totalDurationSeconds,
  validateTour,
} from './tourModel.js';
import {
  deserializeStoryboard,
  exportKml,
  exportWebVtt,
  serializeStoryboard,
} from './storyboardFiles.js';

const STORAGE_KEY = 'museum-tour-storyboard-v1';

function makeId(prefix = 'scene') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function cloneTour(value = initialTour) {
  return JSON.parse(JSON.stringify(value));
}

function createStarterTour() {
  const starter = cloneTour(initialTour);
  return {
    ...starter,
    scenes: starter.scenes.map((scene) => ({
      ...scene,
      camera: { ...scene.camera, altitude: DEFAULT_CAMERA_ALTITUDE },
    })),
  };
}

function formatTime(seconds = 0) {
  const numeric = Number(seconds);
  const value = Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function loadTour() {
  if (typeof window === 'undefined') return createStarterTour();
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return createStarterTour();
    return deserializeStoryboard(saved);
  } catch {
    return createStarterTour();
  }
}

function firstSceneId(scenes) {
  return scenes.find((scene) => scene && typeof scene.id === 'string' && scene.id.trim().length > 0)?.id;
}

function getSceneStart(scenes, sceneId) {
  return sceneStartSeconds(scenes, sceneId) ?? 0;
}

function numericDraftValue(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function issueSceneId(issue, scenes) {
  if (Number.isInteger(issue.sceneIndex)) {
    const indexedScene = scenes[issue.sceneIndex];
    if (indexedScene?.id !== undefined) return indexedScene.id;
  }
  if (issue.sceneId !== undefined && scenes.some((scene) => scene?.id === issue.sceneId)) return issue.sceneId;
  return undefined;
}

function getSceneAtTime(scenes, time) {
  const scene = sceneAtTime(scenes, time);
  if (scene) return scene;
  if (!Array.isArray(scenes) || scenes.length === 0 || !Number.isFinite(time)) return null;
  const total = totalDurationSeconds(scenes);
  return total !== null && time === total ? scenes[scenes.length - 1] : null;
}

function getLandmark(id) {
  return landmarks.find((landmark) => landmark.id === id) || landmarks[0];
}

function formatDistance(meters) {
  if (meters === null || !Number.isFinite(meters)) return 'Route distance unavailable';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function fileNameForTour(title, extension) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'tour';
  return `${base}.${extension}`;
}

function downloadText(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function IconButton({ label, children, className = '', ...props }) {
  return (
    <button className={`icon-button ${className}`} type="button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

function Sidebar({ onExport, onImport, onReset, onPreview, isPreviewOpen }) {
  const importInput = useRef(null);

  return (
    <aside className="sidebar">
      <div className="brand-mark" aria-label="Museum studio">
        <span className="brand-mark__arc" />
        <span className="brand-mark__dot" />
      </div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        <button className="sidebar-nav__item is-active" type="button" title="Storyboard">
          <Layers3 size={19} strokeWidth={1.8} />
          <span>Storyboard</span>
        </button>
        <button className="sidebar-nav__item" type="button" title="Landmark library">
          <MapIcon size={19} strokeWidth={1.8} />
          <span>Landmarks</span>
        </button>
        <button className="sidebar-nav__item" type="button" title="Tour settings">
          <Settings2 size={19} strokeWidth={1.8} />
          <span>Settings</span>
        </button>
      </nav>
      <div className="sidebar-bottom">
        <IconButton label="Import a tour JSON" onClick={() => importInput.current?.click()}>
          <Upload size={18} strokeWidth={1.8} />
        </IconButton>
        <IconButton label="Export tour JSON" onClick={onExport}>
          <Download size={18} strokeWidth={1.8} />
        </IconButton>
        <IconButton label="Reset to starter tour" onClick={onReset}>
          <RotateCcw size={17} strokeWidth={1.8} />
        </IconButton>
        <input
          ref={importInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            onImport(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <div className="sidebar-avatar">MT</div>
      </div>
      {isPreviewOpen && (
        <button className="sidebar-preview-hint" type="button" onClick={onPreview}>
          <CirclePlay size={14} /> Previewing
        </button>
      )}
    </aside>
  );
}

function Topbar({ tour, isPlaying, saveState, canUndo, canRedo, onUndo, onRedo, onPreview, onTitleChange, onSave, onLoad, onExportKml, onExportVtt }) {
  return (
    <header className="topbar">
      <div className="topbar__crumbs">
        <button className="back-button" type="button" aria-label="Back to tour library">
          <ArrowLeft size={17} />
        </button>
        <span className="crumb-muted">Tour library</span>
        <ChevronRight className="crumb-chevron" size={14} />
        <div className="topbar-title-wrap">
          <input aria-label="Tour title" value={tour.title} onChange={(event) => onTitleChange(event.target.value)} />
          <Pencil size={13} className="topbar-title-pencil" />
        </div>
      </div>
      <div className="topbar__actions">
        <span className={`save-state save-state--${saveState}`} role="status"><span className="save-state__dot" /> {saveState === 'unsaved' ? 'Unsaved changes' : saveState === 'error' ? 'Save unavailable' : 'Saved locally'}</span>
        <div className="storyboard-actions" aria-label="Storyboard actions">
          <IconButton label="Undo last change" disabled={!canUndo} onClick={onUndo}><Undo2 size={15} /></IconButton>
          <IconButton label="Redo change" disabled={!canRedo} onClick={onRedo}><Redo2 size={15} /></IconButton>
          <button className="toolbar-action toolbar-action--primary" type="button" onClick={onSave} title="Save storyboard locally (Cmd/Ctrl+S)" aria-keyshortcuts="Meta+S Control+S"><Save size={14} /> Save</button>
          <button className="toolbar-action" type="button" onClick={onLoad} title="Load the locally saved storyboard"><FolderOpen size={14} /> Load</button>
          <button className="toolbar-action" type="button" onClick={onExportKml} title="Export KML gx:Tour" aria-label="Export KML gx:Tour"><FileCode2 size={14} /> KML</button>
          <button className="toolbar-action" type="button" onClick={onExportVtt} title="Export WebVTT captions" aria-label="Export WebVTT captions"><FileText size={14} /> WebVTT</button>
        </div>
        <span className="topbar-divider" />
        <button className={`preview-button ${isPlaying ? 'is-playing' : ''}`} type="button" onClick={onPreview}>
          <Eye size={16} />
          Preview tour
        </button>
      </div>
    </header>
  );
}

function SceneCard({ scene, landmark, index, selected, issueCount, totalScenes, onSelect, onMove, onDelete, onDrop, onDragStart }) {
  return (
    <article
      className={`scene-card ${selected ? 'is-selected' : ''} ${issueCount ? 'has-issues' : ''}`}
      data-scene-id={scene.id}
      tabIndex={0}
      aria-label={`Scene ${index + 1}: ${scene.title || 'Untitled scene'}`}
      aria-current={selected ? 'true' : undefined}
      aria-invalid={issueCount ? 'true' : undefined}
      aria-describedby={issueCount ? `scene-${scene.id}-issues` : undefined}
      onClick={() => onSelect(scene.id)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect(scene.id);
        } else if (event.target === event.currentTarget && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault();
          onSelect(scene.id);
          onMove(index, event.key === 'ArrowUp' ? -1 : 1);
        }
      }}
      aria-keyshortcuts="ArrowUp ArrowDown"
      draggable
      onDragStart={(event) => onDragStart(event, scene.id)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop(event, scene.id)}
    >
      <div className="scene-card__rail">
        <GripVertical className="scene-card__grip" size={15} />
        <span className="scene-card__number">{String(index + 1).padStart(2, '0')}</span>
        {index < totalScenes - 1 && <span className="scene-card__connector" />}
      </div>
      <div className="scene-card__body">
        <div className="scene-card__topline">
          <span className="scene-card__category" style={{ '--category-color': landmark.color }}>{landmark.category}</span>
          <span className="scene-card__duration"><Timer size={12} /> {formatTime(scene.duration)}</span>
        </div>
        <h3>{scene.title || 'Untitled scene'}</h3>
        <p>{scene.caption || 'Add a caption to guide your audience through this moment.'}</p>
        <div className="scene-card__location"><MapIcon size={12} /> {landmark.name}</div>
         {issueCount > 0 && <span className="scene-card__issue-badge" id={`scene-${scene.id}-issues`}><AlertTriangle size={11} /> {issueCount} {issueCount === 1 ? 'warning' : 'warnings'}</span>}
      </div>
      <div className="scene-card__actions">
        <IconButton label="Move scene up" disabled={index === 0} onClick={(event) => { event.stopPropagation(); onMove(index, -1); }}><ChevronUp size={14} /></IconButton>
        <IconButton label="Move scene down" disabled={index === totalScenes - 1} onClick={(event) => { event.stopPropagation(); onMove(index, 1); }}><ChevronDown size={14} /></IconButton>
        <IconButton label="Delete scene" disabled={totalScenes === 1} onClick={(event) => { event.stopPropagation(); onDelete(scene.id); }}><Trash2 size={14} /></IconButton>
      </div>
    </article>
  );
}

function ValidationPanel({ issues, scenes, panelRef, onSceneIssue, onGlobalIssue }) {
  const groupedIssues = scenes.map((scene, index) => ({
    scene,
    index,
    issues: issues.filter((issue) => issueSceneId(issue, scenes) === scene.id || issue.relatedSceneId === scene.id),
  })).filter((group) => group.issues.length > 0);
  const globalIssues = issues.filter((issue) => issueSceneId(issue, scenes) === undefined);

  return (
    <section className={`validation-panel ${issues.length ? 'has-issues' : 'is-valid'}`} ref={panelRef} tabIndex="-1" aria-live="polite" aria-label="Storyboard validation">
      <div className="validation-panel__header">
        <div className="validation-panel__title"><span className="validation-panel__icon">{issues.length ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}</span><span>VALIDATION</span></div>
        <strong>{issues.length} {issues.length === 1 ? 'warning' : 'warnings'}</strong>
      </div>
      {issues.length === 0 ? (
        <p className="validation-panel__empty">Your storyboard is ready to export.</p>
      ) : (
        <div className="validation-issues">
          {globalIssues.length > 0 && (
            <div className="validation-group">
              <span className="validation-group__label">TOUR</span>
              {globalIssues.map((issue, index) => (
                <button className="validation-issue validation-issue--global" type="button" key={`${issue.code}-${index}`} onClick={onGlobalIssue}>
                  <code>{issue.code}</code><span>{issue.message}</span>
                </button>
              ))}
            </div>
          )}
          {groupedIssues.map(({ scene, index: sceneIndex, issues: sceneIssues }) => (
            <div className="validation-group" key={scene.id}>
              <span className="validation-group__label">Scene {String(sceneIndex + 1).padStart(2, '0')} · {scene.title || 'Untitled scene'}</span>
              {sceneIssues.map((issue, index) => (
                <button className="validation-issue" type="button" key={`${issue.code}-${index}`} onClick={() => onSceneIssue(scene.id)}>
                  <code>{issue.code}</code><span>{issue.message}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Timeline({ scenes, selectedId, totalDuration, previewTime, onSelect, onSeekTime }) {
  const seekFromPointer = (event) => {
    if (totalDuration === null || !onSeekTime) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    onSeekTime(progress * totalDuration);
  };

  return (
    <div className="timeline-panel">
      <div className="timeline-panel__header">
        <div className="timeline-label"><span className="timeline-label__mark" /> TIMING TIMELINE</div>
        <div className="timeline-total"><Timer size={14} /> {totalDuration === null ? 'Duration unavailable' : `${formatTime(totalDuration)} total`}</div>
      </div>
      <div className="timeline-track-wrap">
        <div className="timeline-track" onPointerDown={seekFromPointer} role="slider" tabIndex={0} aria-label="Tour playback position" aria-valuemin={0} aria-valuemax={totalDuration ?? 0} aria-valuenow={totalDuration === null ? 0 : previewTime} onKeyDown={(event) => {
          if (totalDuration === null || !onSeekTime) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            onSeekTime(Math.max(0, Math.min(totalDuration, previewTime + (event.key === 'ArrowLeft' ? -1 : 1))));
          }
        }}>
          {scenes.map((scene, index) => {
            const width = totalDuration ? (scene.duration / totalDuration) * 100 : 100 / scenes.length;
            const landmark = getLandmark(scene.landmarkId);
            return (
              <button
                type="button"
                key={scene.id}
                className={`timeline-segment ${selectedId === scene.id ? 'is-selected' : ''}`}
                style={{ width: `${width}%`, '--segment-color': landmark.color }}
                onClick={(event) => { event.stopPropagation(); onSelect(scene.id); }}
                onPointerDown={(event) => event.stopPropagation()}
                title={`${scene.title} · ${formatTime(scene.duration)}`}
              >
                <span>{index + 1}</span>
                <b>{scene.title}</b>
              </button>
            );
          })}
          {totalDuration > 0 && <div className="timeline-playhead" style={{ left: `${Math.min(100, Math.max(0, (previewTime / totalDuration) * 100))}%` }} />}
        </div>
        <div className="timeline-scrub-row">
          <input className="timeline-scrubber" type="range" min="0" max={totalDuration ?? 0} step="0.1" value={totalDuration === null ? 0 : Math.min(totalDuration, Math.max(0, previewTime))} disabled={totalDuration === null} aria-label="Scrub tour playback" onChange={(event) => onSeekTime?.(Number(event.target.value))} />
          <div className="timeline-ruler"><span>00:00</span><span>{totalDuration === null ? '--:--' : formatTime(totalDuration / 2)}</span><span>{totalDuration === null ? '--:--' : formatTime(totalDuration)}</span></div>
        </div>
      </div>
    </div>
  );
}

function CameraField({ label, value, onChange, min, max, step = 0.01, suffix, invalid, descriptionId }) {
  return (
    <label className="camera-field">
      <span>{label}</span>
      <div className="camera-field__input">
        <input type="number" min={min} max={max} step={step} value={value ?? ''} aria-label={label} aria-invalid={invalid || undefined} aria-describedby={descriptionId} onChange={(event) => onChange(event.target.value)} />
        {suffix && <small>{suffix}</small>}
      </div>
    </label>
  );
}

function Inspector({ scene, sceneNumber, totalScenes, issues, cameraMode, onCameraMode, onSceneChange, onCameraChange, onResetCamera }) {
  if (!scene) {
    return <aside className="inspector empty-inspector"><Compass size={28} /><p>Select a scene to edit its camera and narration.</p></aside>;
  }
  const landmark = getLandmark(scene.landmarkId);
  const camera = scene.camera || {};
  const hasFieldIssue = (field) => issues.some((issue) => issue.field === field);
  const captionTiming = scene.captionTiming && typeof scene.captionTiming === 'object' && !Array.isArray(scene.captionTiming)
    ? scene.captionTiming
    : {};
  const captionStart = captionTiming.start ?? 0;
  const captionEnd = captionTiming.end ?? scene.duration ?? '';
  const updateCaptionTiming = (field, value) => onSceneChange({
    captionTiming: { ...captionTiming, [field]: numericDraftValue(value) },
  });

  return (
    <aside className="inspector">
      <div className="inspector__header">
        <div>
          <span className="eyebrow">SCENE {String(sceneNumber).padStart(2, '0')} <span>/ {String(totalScenes).padStart(2, '0')}</span></span>
          <h2>Scene details</h2>
        </div>
        <IconButton label="Scene settings"><Settings2 size={17} /></IconButton>
      </div>

      <div className="inspector__scroll">
        <section className="inspector-section">
          <label className="field-label" htmlFor="scene-location">Location</label>
          <div className="select-wrap">
            <MapIcon size={15} />
            <select id="scene-location" value={scene.landmarkId ?? ''} onChange={(event) => onSceneChange({ landmarkId: event.target.value })}>
              {landmarks.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select>
            <ChevronDown size={15} />
          </div>
          <p className="field-help">{landmark.description}</p>
        </section>

        <section className="inspector-section">
          <label className="field-label" htmlFor="scene-title">Scene title</label>
           <input id="scene-title" className="text-input" value={scene.title ?? ''} onChange={(event) => onSceneChange({ title: event.target.value })} placeholder="Give this moment a title" />
           <label className="field-label field-label--spaced" htmlFor="scene-caption">Caption / narration</label>
           <textarea id="scene-caption" className="text-area" rows="5" value={scene.caption ?? ''} onChange={(event) => onSceneChange({ caption: event.target.value })} placeholder="What should your audience notice here?" />
           <div className="caption-timing-heading">
             <span className="field-label">Caption timing</span>
             <button className="subtle-action" type="button" onClick={() => onSceneChange({ captionTiming: undefined })}>Use full scene</button>
           </div>
           <p className="field-help caption-timing-help">Optional offsets in seconds. Full-scene captions are used by default.</p>
           <div className="caption-timing-fields">
             <CameraField label="START" value={captionStart} step="0.001" min="0" invalid={hasFieldIssue('captionTiming')} onChange={(value) => updateCaptionTiming('start', value)} />
             <CameraField label="END" value={captionEnd} step="0.001" min="0" invalid={hasFieldIssue('captionTiming') || hasFieldIssue('captionTiming.end')} onChange={(value) => updateCaptionTiming('end', value)} />
           </div>
         </section>

        <section className="inspector-section inspector-section--duration">
          <div className="section-heading-row"><label className="field-label" htmlFor="scene-duration">Hold duration</label><span className="field-meta">SECONDS</span></div>
          <div className="duration-input-wrap"><input id="scene-duration" type="number" min="1" step="1" value={scene.duration ?? ''} aria-invalid={hasFieldIssue('duration') || undefined} onChange={(event) => onSceneChange({ duration: numericDraftValue(event.target.value) })} /><span>sec</span></div>
          <input className="duration-range" aria-label="Scene duration" type="range" min="5" max="90" step="1" value={typeof scene.duration === 'number' ? Math.min(90, Math.max(5, scene.duration)) : 5} onChange={(event) => onSceneChange({ duration: Number(event.target.value) })} />
          <div className="range-labels"><span>05 sec</span><span>01:30</span></div>
        </section>

        <section className="inspector-section inspector-section--camera">
          <div className="section-heading-row"><div><span className="field-label">Camera position</span><span className="camera-subline"><LocateFixed size={12} /> {cameraMode ? 'Click anywhere on the map' : 'Set the opening frame'}</span></div><Compass size={19} className="section-icon" /></div>
          <div className="camera-coords">
            <CameraField label="LAT" value={camera.lat} step="0.0001" min="-90" max="90" invalid={hasFieldIssue('camera.lat')} onChange={(value) => onCameraChange('lat', value)} />
            <CameraField label="LNG" value={camera.lng} step="0.0001" min="-180" max="180" invalid={hasFieldIssue('camera.lng')} onChange={(value) => onCameraChange('lng', value)} />
          </div>
          <div className="camera-altitude">
            <CameraField label="Camera altitude" value={camera.altitude} step="1" min="1" max="100000" suffix="m AGL" invalid={hasFieldIssue('camera.altitude')} descriptionId="camera-altitude-help" onChange={(value) => onCameraChange('altitude', value)} />
            <p id="camera-altitude-help" className="field-help">Metres above ground level (AGL).</p>
          </div>
          <button className={`map-pick-button ${cameraMode ? 'is-active' : ''}`} type="button" onClick={onCameraMode}>
            <MousePointer2 size={15} /> {cameraMode ? 'Click map to place camera' : 'Set position on map'}
          </button>
          <div className="camera-controls">
            <label><span>ZOOM</span><input type="range" min="0.8" max="2.5" step="0.05" value={camera.zoom ?? 1.25} onChange={(event) => onCameraChange('zoom', event.target.value)} /><b>{Number(camera.zoom ?? 1.25).toFixed(2)}</b></label>
            <label><span>BEARING</span><input type="range" min="0" max="360" step="1" value={camera.bearing ?? 0} onChange={(event) => onCameraChange('bearing', event.target.value)} /><b>{Math.round(Number(camera.bearing ?? 0))}°</b></label>
            <label><span>TILT</span><input type="range" min="0" max="45" step="1" value={camera.tilt ?? 0} onChange={(event) => onCameraChange('tilt', event.target.value)} /><b>{Math.round(Number(camera.tilt ?? 0))}°</b></label>
          </div>
          <button className="subtle-action" type="button" onClick={onResetCamera}><RotateCcw size={13} /> Reset to landmark</button>
        </section>
      </div>
    </aside>
  );
}

function PreviewOverlay({ tour, selectedId, previewTime, isPlaying, activeScene, activeCamera, activeCaption, captionWindow, totalDuration, onClose, onPlayPause, onSeekScene, onStep, onSeekTime }) {
  const progress = totalDuration ? previewTime / totalDuration : 0;
  return (
    <div className="preview-overlay" role="dialog" aria-modal="true" aria-label="Tour preview">
      <div className="preview-overlay__topbar">
        <div className="preview-overlay__title"><span className="preview-live-dot" /> LIVE PREVIEW <span>/</span> {tour.title}</div>
        <div className="preview-overlay__top-actions"><span className="preview-clock">{formatTime(previewTime)} / {formatTime(totalDuration)}</span><IconButton label="Close preview" onClick={onClose}><X size={19} /></IconButton></div>
      </div>
      <div className="preview-overlay__body">
        <div className="preview-map-wrap">
          <RouteMap scenes={tour.scenes} selectedId={activeScene?.id || selectedId} onSelect={onSeekScene} activeProgress={progress} activeCamera={activeCamera} playing={isPlaying} showLabels />
          <div className="preview-map-note"><Maximize2 size={13} /> Camera path preview <span>{isPlaying ? 'LIVE' : 'PAUSED'}</span></div>
        </div>
        <div className="preview-copy">
          <div className="preview-copy__number">{activeScene ? `SCENE ${String(tour.scenes.indexOf(activeScene) + 1).padStart(2, '0')}` : 'SCENE'}</div>
          <h1>{activeScene?.title || tour.title}</h1>
          {activeCaption ? <p>{activeCaption}</p> : <p className="preview-copy__caption-muted">Caption is not on screen at this moment.</p>}
          <div className="preview-copy__location"><MapIcon size={14} /> {activeScene ? getLandmark(activeScene.landmarkId).name : 'Central Paris'}</div>
          {activeCamera && <div className="preview-copy__camera"><Compass size={13} /> Camera {activeCamera.lat.toFixed(4)}, {activeCamera.lng.toFixed(4)} · {Math.round(activeCamera.altitude)} m AGL</div>}
          <div className={`preview-copy__caption-window ${activeCaption ? 'is-visible' : ''}`}><Timer size={13} /> Caption {captionWindow ? `${formatTime(captionWindow.start)} – ${formatTime(captionWindow.end)}` : 'timing unavailable'}</div>
        </div>
      </div>
      <div className="preview-controls">
        <div className="preview-controls__scenes">
          {tour.scenes.map((scene, index) => <button type="button" key={scene.id} className={activeScene?.id === scene.id ? 'is-active' : ''} onClick={() => onSeekScene(scene.id)}><span>{String(index + 1).padStart(2, '0')}</span>{getLandmark(scene.landmarkId).name}</button>)}
        </div>
        <div className="preview-controls__transport">
          <IconButton label="Previous scene" onClick={() => onStep(-1)}><ChevronLeft size={19} /></IconButton>
          <button className="preview-play" type="button" onClick={onPlayPause}>{isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
          <IconButton label="Next scene" onClick={() => onStep(1)}><ChevronRight size={19} /></IconButton>
        </div>
        <div className="preview-controls__duration"><span>{formatTime(previewTime)}</span><input className="preview-scrubber" type="range" min="0" max={totalDuration ?? 0} step="0.1" value={totalDuration === null ? 0 : Math.min(totalDuration, Math.max(0, previewTime))} disabled={totalDuration === null} aria-label="Scrub preview" onChange={(event) => onSeekTime?.(Number(event.target.value))} /><span>{formatTime(totalDuration)}</span></div>
      </div>
    </div>
  );
}

export default function App() {
  const [tour, setTour] = useState(loadTour);
  const [selectedSceneId, setSelectedSceneId] = useState(() => firstSceneId(tour.scenes));
  const [cameraMode, setCameraMode] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [toast, setToast] = useState('');
  const [toastKind, setToastKind] = useState('success');
  const [mapZoom, setMapZoom] = useState(1);
  const [saveState, setSaveState] = useState('unsaved');
  const [exportFailure, setExportFailure] = useState(null);
  const [history, setHistory] = useState({ past: [], future: [] });
  const validationPanelRef = useRef(null);
  const sceneListRef = useRef(null);
  const tourRef = useRef(tour);
  const playbackClockRef = useRef(null);

  const selectedScene = tour.scenes.find((scene) => scene.id === selectedSceneId) || tour.scenes[0];
  const selectedIndex = Math.max(0, tour.scenes.findIndex((scene) => scene.id === selectedScene?.id));
  const totalDuration = useMemo(() => totalDurationSeconds(tour.scenes), [tour.scenes]);
  const routeDistance = useMemo(() => routeDistanceMeters(tour.scenes), [tour.scenes]);
  const activeCamera = useMemo(() => cameraAtTime(tour.scenes, previewTime), [tour.scenes, previewTime]);
  const validationIssues = useMemo(() => {
    const issues = validateTour(tour);
    if (totalDuration === null && !issues.some((issue) => issue.code === 'invalid_duration' || issue.code === 'invalid_total_duration')) {
      issues.push({ code: 'invalid_total_duration', field: 'scenes', message: 'Total scene duration must be finite.' });
    }
    if (exportFailure?.tour === tour) {
      for (const issue of exportFailure.issues) {
        if (!issues.some((item) => item.code === issue.code && item.field === issue.field && item.sceneId === issue.sceneId)) issues.push(issue);
      }
    }
    return issues;
  }, [tour, totalDuration, exportFailure]);
  const sceneIssues = useMemo(() => {
    const grouped = new Map();
    for (const issue of validationIssues) {
      const id = issueSceneId(issue, tour.scenes);
      if (id === undefined) continue;
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(issue);
      if (issue.relatedSceneId && issue.relatedSceneId !== id && tour.scenes.some((scene) => scene?.id === issue.relatedSceneId)) {
        if (!grouped.has(issue.relatedSceneId)) grouped.set(issue.relatedSceneId, []);
        grouped.get(issue.relatedSceneId).push(issue);
      }
    }
    return grouped;
  }, [validationIssues, tour.scenes]);
  const activePreviewScene = getSceneAtTime(tour.scenes, previewTime);
  const activeSceneStart = activePreviewScene ? getSceneStart(tour.scenes, activePreviewScene.id) : 0;
  const activeCaptionWindow = activePreviewScene ? captionInterval(activePreviewScene, activeSceneStart) : null;
  const captionIsVisible = Boolean(
    activePreviewScene
    && typeof activePreviewScene.caption === 'string'
    && activePreviewScene.caption.trim()
    && activeCaptionWindow
    && previewTime >= activeCaptionWindow.start
    && previewTime < activeCaptionWindow.end,
  );
  const activeCaption = captionIsVisible ? activePreviewScene.caption : '';

  useEffect(() => {
    tourRef.current = tour;
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeStoryboard(tour));
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, [tour]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(''), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!isPlaying || totalDuration === null) return undefined;
    playbackClockRef.current = performance.now();
    const interval = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.max(0, (now - playbackClockRef.current) / 1000);
      playbackClockRef.current = now;
      setPreviewTime((current) => {
        const next = Math.min(totalDuration, current + elapsed);
        if (next >= totalDuration) {
          setIsPlaying(false);
          return totalDuration;
        }
        return next;
      });
    }, 50);
    return () => window.clearInterval(interval);
  }, [isPlaying, totalDuration]);

  useEffect(() => {
    if (isPlaying && activePreviewScene && activePreviewScene.id !== selectedSceneId) setSelectedSceneId(activePreviewScene.id);
  }, [activePreviewScene, isPlaying, selectedSceneId]);

  const notify = (message, kind = 'success') => {
    setToastKind(kind);
    setToast(message);
  };

  const updateTour = (updater) => {
    const current = tourRef.current;
    const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
    if (next === current || JSON.stringify(next) === JSON.stringify(current)) return;
    tourRef.current = next;
    setHistory((currentHistory) => ({
      past: [...currentHistory.past, current].slice(-50),
      future: [],
    }));
    setSaveState('unsaved');
    setTour(next);
  };

  const undo = () => {
    if (!history.past.length) return;
    const previous = history.past[history.past.length - 1];
    setHistory({ past: history.past.slice(0, -1), future: [tour, ...history.future].slice(0, 50) });
    tourRef.current = previous;
    setTour(previous);
    setSaveState('unsaved');
    setExportFailure(null);
    if (!previous.scenes.some((scene) => scene.id === selectedSceneId)) setSelectedSceneId(firstSceneId(previous.scenes));
  };

  const redo = () => {
    if (!history.future.length) return;
    const next = history.future[0];
    setHistory({ past: [...history.past, tour].slice(-50), future: history.future.slice(1) });
    tourRef.current = next;
    setTour(next);
    setSaveState('unsaved');
    setExportFailure(null);
    if (!next.scenes.some((scene) => scene.id === selectedSceneId)) setSelectedSceneId(firstSceneId(next.scenes));
  };

  const focusValidation = () => {
    setIsPreviewOpen(false);
    setIsPlaying(false);
    window.requestAnimationFrame(() => {
      validationPanelRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      validationPanelRef.current?.focus({ preventScroll: true });
    });
  };

  const focusScene = (id) => {
    setSelectedSceneId(id);
    setPreviewTime(getSceneStart(tour.scenes, id));
    setCameraMode(false);
    setIsPlaying(false);
    window.requestAnimationFrame(() => {
      const card = Array.from(sceneListRef.current?.querySelectorAll('[data-scene-id]') || []).find((element) => element.dataset.sceneId === id);
      card?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      card?.focus({ preventScroll: true });
    });
  };

  const saveStoryboard = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeStoryboard(tour));
      setSaveState('saved');
      notify('Storyboard saved locally');
    } catch (error) {
      setSaveState('error');
      notify(`Could not save storyboard: ${error.message || 'Local storage is unavailable.'}`, 'error');
    }
  };

  const applyStoryboard = (loaded, action) => {
    tourRef.current = loaded;
    setTour(loaded);
    setHistory({ past: [], future: [] });
    setSaveState('unsaved');
    setSelectedSceneId(firstSceneId(loaded.scenes));
    setCameraMode(false);
    setIsPlaying(false);
    setIsPreviewOpen(false);
    setPreviewTime(0);
    setExportFailure(null);
    const issues = validateTour(loaded);
    notify(issues.length ? `${action} with ${issues.length} validation ${issues.length === 1 ? 'warning' : 'warnings'}. Review the validation panel.` : `${action} successfully`, issues.length ? 'warning' : 'success');
    if (issues.length) window.setTimeout(focusValidation, 0);
  };

  const loadStoryboard = () => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        notify('No saved storyboard found in this browser', 'warning');
        return;
      }
      applyStoryboard(deserializeStoryboard(saved), 'Storyboard loaded');
    } catch (error) {
      notify(`Could not load storyboard: ${error.message || 'Invalid saved storyboard.'}`, 'error');
    }
  };

  const updateSelectedScene = (updates) => {
    if (!selectedScene) return;
    updateTour((current) => ({
      ...current,
      scenes: current.scenes.map((scene) => {
        if (scene.id !== selectedScene.id) return scene;
        if (!updates.landmarkId || updates.landmarkId === scene.landmarkId) {
          const nextScene = { ...scene, ...updates };
          if (Object.prototype.hasOwnProperty.call(updates, 'captionTiming') && updates.captionTiming === undefined) delete nextScene.captionTiming;
          return nextScene;
        }
        const landmark = getLandmark(updates.landmarkId);
        return {
          ...scene,
          ...updates,
          camera: { ...(scene.camera || {}), lat: landmark.lat, lng: landmark.lng },
        };
      }),
    }));
  };

  const updateCamera = (field, value) => {
    if (!selectedScene) return;
    const draftValue = numericDraftValue(value);
    updateTour((current) => ({ ...current, scenes: current.scenes.map((scene) => scene.id === selectedScene.id ? { ...scene, camera: { ...(scene.camera || {}), [field]: draftValue } } : scene) }));
  };

  const addScene = () => {
    const usedLandmarkIds = new Set(tour.scenes.map((scene) => scene.landmarkId));
    const landmark = landmarks.find((item) => !usedLandmarkIds.has(item.id)) || landmarks[(tour.scenes.length) % landmarks.length];
    const newScene = {
      id: makeId(),
      landmarkId: landmark.id,
      title: `A closer look at ${landmark.name}`,
      caption: landmark.description,
      duration: 25,
      camera: { lat: landmark.lat, lng: landmark.lng, altitude: DEFAULT_CAMERA_ALTITUDE, zoom: 1.25, bearing: 0, tilt: 12 },
    };
    updateTour((current) => ({ ...current, scenes: [...current.scenes, newScene] }));
    setSelectedSceneId(newScene.id);
    notify('New scene added to the route');
  };

  const deleteScene = (sceneId) => {
    if (tour.scenes.length === 1) return;
    const index = tour.scenes.findIndex((scene) => scene.id === sceneId);
    const remaining = tour.scenes.filter((scene) => scene.id !== sceneId);
    updateTour((current) => ({ ...current, scenes: remaining }));
    if (sceneId === selectedSceneId) setSelectedSceneId(remaining[Math.max(0, index - 1)]?.id);
    notify('Scene removed');
  };

  const moveScene = (index, direction) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= tour.scenes.length) return;
    updateTour((current) => {
      const scenes = [...current.scenes];
      [scenes[index], scenes[nextIndex]] = [scenes[nextIndex], scenes[index]];
      return { ...current, scenes };
    });
  };

  const moveByDrop = (event, targetId) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === targetId) return;
    updateTour((current) => {
      const scenes = [...current.scenes];
      const sourceIndex = scenes.findIndex((scene) => scene.id === sourceId);
      const targetIndex = scenes.findIndex((scene) => scene.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const [moved] = scenes.splice(sourceIndex, 1);
      scenes.splice(targetIndex, 0, moved);
      return { ...current, scenes };
    });
  };

  const exportTour = () => {
    try {
      downloadText(fileNameForTour(tour.title, 'json'), serializeStoryboard(tour), 'application/json;charset=utf-8');
      notify('Storyboard JSON downloaded');
    } catch (error) {
      notify(`Could not download storyboard: ${error.message}`, 'error');
    }
  };

  const exportFile = (format) => {
    if (validationIssues.length) {
      focusValidation();
      notify(`Export blocked: resolve ${validationIssues.length} validation ${validationIssues.length === 1 ? 'warning' : 'warnings'}`, 'warning');
      return;
    }
    try {
      const isKml = format === 'kml';
      const content = isKml ? exportKml(tour) : exportWebVtt(tour);
      downloadText(fileNameForTour(tour.title, isKml ? 'kml' : 'vtt'), content, isKml ? 'application/vnd.google-earth.kml+xml;charset=utf-8' : 'text/vtt;charset=utf-8');
      notify(isKml ? 'KML gx:Tour exported' : 'WebVTT captions exported');
    } catch (error) {
      if (Array.isArray(error.issues)) {
        setExportFailure({ tour, issues: error.issues });
        focusValidation();
      }
      notify(`Could not export: ${error.message}`, 'error');
    }
  };

  const importTour = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applyStoryboard(deserializeStoryboard(reader.result), 'Storyboard imported');
      } catch (error) {
        notify(`Could not import storyboard: ${error.message}`, 'error');
      }
    };
    reader.onerror = () => notify('Could not read that storyboard file', 'error');
    reader.readAsText(file);
  };

  const resetTour = () => {
    if (!window.confirm('Reset this storyboard to the starter Paris tour?')) return;
    applyStoryboard(createStarterTour(), 'Starter tour restored');
  };

  const openPreview = () => {
    if (totalDuration === null) {
      focusValidation();
      notify('Correct scene durations before previewing the tour', 'warning');
      return;
    }
    setPreviewTime(selectedScene ? getSceneStart(tour.scenes, selectedScene.id) : 0);
    setIsPreviewOpen(true);
    setIsPlaying(false);
  };

  const seekScene = (sceneId) => {
    setSelectedSceneId(sceneId);
    setPreviewTime(getSceneStart(tour.scenes, sceneId));
  };

  const seekTime = (time) => {
    if (totalDuration === null) return;
    setPreviewTime(Math.max(0, Math.min(totalDuration, Number(time) || 0)));
  };

  const stepPreview = (direction) => {
    const index = tour.scenes.findIndex((scene) => scene.id === activePreviewScene?.id);
    const next = tour.scenes[Math.max(0, Math.min(tour.scenes.length - 1, index + direction))];
    if (next) seekScene(next.id);
  };

  const handleMapClick = ({ lat, lng }) => {
    if (!cameraMode || !selectedScene) return;
    updateCamera('lat', lat.toFixed(5));
    updateCamera('lng', lng.toFixed(5));
    setCameraMode(false);
    notify('Camera position updated');
  };

  const ToastIcon = toastKind === 'success' ? Check : AlertTriangle;

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveStoryboard();
      } else if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      } else if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        addScene();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tour, selectedSceneId, history]);

  return (
    <div className="app-shell">
      <Sidebar onExport={exportTour} onImport={importTour} onReset={resetTour} onPreview={openPreview} isPreviewOpen={isPreviewOpen} />
      <div className="app-frame">
        <Topbar tour={tour} isPlaying={isPlaying} saveState={saveState} canUndo={history.past.length > 0} canRedo={history.future.length > 0} onUndo={undo} onRedo={redo} onSave={saveStoryboard} onLoad={loadStoryboard} onExportKml={() => exportFile('kml')} onExportVtt={() => exportFile('vtt')} onPreview={openPreview} onTitleChange={(title) => updateTour({ title })} />
        <main className="editor-layout">
          <section className="storyboard-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">EDITORIAL FLOW</span>
                <h1>Storyboard</h1>
              </div>
              <span className="scene-count">{String(tour.scenes.length).padStart(2, '0')} scenes</span>
            </div>
            <div className="tour-meta-editor">
              <label htmlFor="tour-subtitle">Tour introduction</label>
              <input id="tour-subtitle" value={tour.subtitle} onChange={(event) => updateTour({ subtitle: event.target.value })} placeholder="A short line for your tour" />
            </div>
            <div className="scene-list-heading"><span>SEQUENCE</span><span>DRAG TO REORDER</span></div>
            <div className="scene-list" ref={sceneListRef}>
              {tour.scenes.map((scene, index) => <SceneCard key={scene.id} scene={scene} landmark={getLandmark(scene.landmarkId)} index={index} issueCount={sceneIssues.get(scene.id)?.length || 0} totalScenes={tour.scenes.length} selected={scene.id === selectedScene?.id} onSelect={focusScene} onMove={moveScene} onDelete={deleteScene} onDrop={moveByDrop} onDragStart={(event, id) => event.dataTransfer.setData('text/plain', id)} />)}
            </div>
            <button className="add-scene-button" type="button" onClick={addScene}><Plus size={17} /> Add scene <span>⌘ / Ctrl K</span></button>
            <div className="storyboard-footer-note"><Sparkles size={14} /><span>Tip: Keep each scene focused on one visual idea.</span></div>
          </section>

          <section className="canvas-panel">
            <div className="canvas-toolbar">
              <div className="canvas-toolbar__title"><span className="canvas-live-dot" /> ROUTE CANVAS <span className="canvas-toolbar__divider" /> <span className="canvas-location">Paris, France</span></div>
              <div className="route-metrics" aria-label="Route metrics">
                <span><Timer size={13} /> {totalDuration === null ? 'Duration unavailable' : formatTime(totalDuration)}</span>
                <span><Route size={13} /> {formatDistance(routeDistance)}</span>
              </div>
              <div className="canvas-toolbar__tools">
                <button className="map-tool-button" type="button" onClick={() => setMapZoom((value) => value === 1 ? 1.2 : 1)}><Maximize2 size={14} /> {mapZoom === 1 ? 'Fit route' : 'Reset view'}</button>
                <span className="toolbar-separator" />
                <IconButton label="Map layers"><SlidersHorizontal size={16} /></IconButton>
              </div>
            </div>
            <div className="map-canvas"><RouteMap scenes={tour.scenes} selectedId={activePreviewScene?.id || selectedScene?.id} onSelect={focusScene} onMapClick={handleMapClick} cameraMode={cameraMode} zoom={mapZoom} activeProgress={totalDuration ? previewTime / totalDuration : 0} activeCamera={activeCamera} playing={isPlaying} /></div>
            <Timeline scenes={tour.scenes} selectedId={selectedScene?.id} totalDuration={totalDuration} previewTime={previewTime} onSelect={seekScene} onSeekTime={seekTime} />
            <ValidationPanel issues={validationIssues} scenes={tour.scenes} panelRef={validationPanelRef} onSceneIssue={focusScene} onGlobalIssue={focusValidation} />
          </section>

          <Inspector scene={selectedScene} issues={sceneIssues.get(selectedScene?.id) || []} sceneNumber={selectedIndex + 1} totalScenes={tour.scenes.length} cameraMode={cameraMode} onCameraMode={() => setCameraMode((value) => !value)} onSceneChange={updateSelectedScene} onCameraChange={updateCamera} onResetCamera={() => { if (!selectedScene) return; const landmark = getLandmark(selectedScene.landmarkId); updateTour((current) => ({ ...current, scenes: current.scenes.map((scene) => scene.id === selectedScene.id ? { ...scene, camera: { ...(scene.camera || {}), lat: landmark.lat, lng: landmark.lng } } : scene) })); }} />
        </main>
      </div>
      {toast && <div className={`toast toast--${toastKind}`} role="status"><ToastIcon size={15} /> {toast}</div>}
      {isPreviewOpen && <PreviewOverlay tour={tour} selectedId={selectedScene?.id} previewTime={previewTime} isPlaying={isPlaying} activeScene={activePreviewScene} activeCamera={activeCamera} activeCaption={activeCaption} captionWindow={activeCaptionWindow} totalDuration={totalDuration} onClose={() => { setIsPreviewOpen(false); setIsPlaying(false); }} onPlayPause={() => setIsPlaying((value) => !value)} onSeekScene={seekScene} onStep={stepPreview} onSeekTime={seekTime} />}
    </div>
  );
}
