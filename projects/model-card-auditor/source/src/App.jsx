import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Download,
  FileCheck2,
  FileText,
  Github,
  Info,
  Keyboard,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
  TriangleAlert,
  Users,
  X,
  Zap,
} from "lucide-react";
import { modelCards } from "./data/modelCards.js";
import { auditModelCard, validMetric } from "./lib/audit.js";
import { useWorkspaceRoute } from "./lib/useWorkspaceRoute.js";
import { downloadReviewPacket } from "./lib/download.js";
import {
  ExportModal,
  MethodologyModal,
  SearchModal,
} from "./components/Modal.jsx";
import { FindingEvidence } from "./components/FindingEvidence.jsx";
import RiskDashboard from "./components/RiskDashboard.jsx";
import PacketPreview from "./components/PacketPreview.jsx";
import ScoringRulesPanel from "./components/ScoringRulesPanel.jsx";
import ThreatFixturesPanel from "./components/ThreatFixturesPanel.jsx";

const tabs = [
  { id: "overview", label: "Overview" },
  { id: "fairness", label: "Fairness" },
  { id: "privacy", label: "Data & privacy" },
  { id: "security", label: "Security" },
  { id: "accessibility", label: "Accessibility" },
];

const navigation = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "model-cards", label: "Model cards", icon: FileText },
  { id: "fairness", label: "Subgroup fairness", icon: BarChart3 },
  { id: "privacy", label: "Data & consent", icon: LockKeyhole },
  { id: "security", label: "Threat assessment", icon: ShieldAlert },
  { id: "accessibility", label: "Accessibility", icon: Keyboard },
  { id: "risk-tradeoffs", label: "Risk trade-offs", icon: Target },
  { id: "packet-preview", label: "Packet preview", icon: ClipboardCheck },
];

function scoreClass(score) {
  if (score >= 85) return "good";
  if (score >= 65) return "watch";
  return "risk";
}

function findingFor(audit, id) {
  return audit.findings.find((finding) => finding.id === id);
}

function App() {
  const [route, navigate] = useWorkspaceRoute();
  const selectedId = route.modelId;
  const selectedCard =
    modelCards.find((card) => card.id === selectedId) || modelCards[0];
  const audit = useMemo(() => auditModelCard(selectedCard), [selectedCard]);
  const [activeTab, setActiveTab] = useState("overview");
  const [activeNav, setActiveNav] = useState("overview");
  const [lastAuditId, setLastAuditId] = useState(null);
  const auditState = lastAuditId === selectedId ? "complete" : "ready";
  const [notesByModel, setNotesByModel] = useState({});
  const notes = notesByModel[selectedId] || "";
  const setNotes = (value) =>
    setNotesByModel((current) => ({ ...current, [selectedId]: value }));
  const [showExport, setShowExport] = useState(false);
  const [showMethodology, setShowMethodology] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const tabRefs = useRef([]);
  const previousPage = useRef(route.page);

  useEffect(() => {
    if (previousPage.current !== route.page) {
      document.getElementById("route-content")?.focus();
      previousPage.current = route.page;
    }
    setShowExport(false);
    setShowMethodology(false);
    setShowSearch(false);
  }, [route.page, route.modelId]);

  const counts = useMemo(
    () => ({
      high: audit.findings.filter((finding) => finding.severity === "high")
        .length,
      medium: audit.findings.filter((finding) => finding.severity === "medium")
        .length,
      low: audit.findings.filter((finding) => finding.severity === "low")
        .length,
    }),
    [audit],
  );

  function selectCard(id) {
    const card = modelCards.find((item) => item.id === id) || modelCards[0];
    navigate(route.page === "not-found" ? "audit" : route.page, card.id);
    setLastAuditId(null);
    setActiveTab("overview");
    setActiveNav("overview");
    setShowSearch(false);
    setQuery("");
  }

  function runAudit() {
    // Scoring is synchronous and deterministic; never leave a stale card result in a timer.
    setLastAuditId(selectedId);
  }

  function activateArea(id) {
    if (id === "risk-tradeoffs" || id === "packet-preview") {
      navigate(id, selectedId);
      return;
    }
    if (route.page !== "audit") navigate("audit", selectedId);
    const target = id === "model-cards" ? "overview" : id;
    setActiveNav(id);
    setActiveTab(target);
    document
      .getElementById("audit-content")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const previewPacket = () => navigate("packet-preview", selectedId);
  const openRiskDashboard = () => navigate("risk-tradeoffs", selectedId);
  const navigationArea = route.page === "audit" ? activeNav : route.page;

  function handleTabKey(event, index) {
    let next = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft")
      next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next !== null) {
      event.preventDefault();
      tabRefs.current[next]?.focus();
      if (event.key !== "Home" && event.key !== "End")
        setActiveTab(tabs[next].id);
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActiveTab(tabs[index].id);
    }
  }

  if (route.page === "not-found")
    return (
      <div className="route-error" role="main" id="route-content" tabIndex="-1">
        <h1>
          {route.problem === "unknown-model"
            ? "Model card not found"
            : "Page not found"}
        </h1>
        <p>
          {route.problem === "unknown-model"
            ? "This URL does not identify a bundled synthetic model card. No other card has been substituted."
            : "This local review page does not exist."}
        </p>
        <button
          className="button primary"
          onClick={() => navigate("audit", modelCards[0].id)}
        >
          Return to model card audit
        </button>
      </div>
    );

  return (
    <div className={`app-shell ${route.page !== "audit" ? "app-shell--routed" : ""}`}>
      <a className="skip-link" href="#audit-content">
        Skip to audit
      </a>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={16} />
          </div>
          <span>Prism</span>
          <span className="brand-divider" />{" "}
          <span className="brand-subtitle">Model Card Auditor</span>
        </div>
        <div className="topbar-actions">
          <span className="local-pill">
            <span className="live-dot" />
            Local only
          </span>
          <button
            className="icon-button top-icon"
            aria-label="Search model cards"
            onClick={() => setShowSearch(true)}
          >
            <Search size={19} />
          </button>
          <button
            className="icon-button top-icon"
            aria-label="Help and methodology"
            onClick={() => setShowMethodology(true)}
          >
            <CircleHelp size={19} />
          </button>
          <span className="avatar">RA</span>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-top">
            <p className="eyebrow">WORKSPACE</p>
            <button className="workspace-select" aria-label="Current workspace">
              <span className="workspace-dot">A</span>
              <span>
                <strong>AI Safety Review</strong>
                <small>Personal workspace</small>
              </span>
              <ChevronDown size={15} />
            </button>
          </div>
          <nav aria-label="Workspace navigation" className="side-nav">
            {navigation.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                aria-label={label}
                aria-current={navigationArea === id ? "page" : undefined}
                className={`side-nav-item ${navigationArea === id ? "active" : ""}`}
                onClick={() => activateArea(id)}
              >
                <Icon size={17} />
                <span>{label}</span>
                {id === "model-cards" && (
                  <span className="nav-count" aria-hidden="true">
                    3
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="tip-card">
              <div className="tip-icon">
                <Zap size={16} />
              </div>
              <strong>Make a stronger claim</strong>
              <p>Claims with evidence references are easier to review.</p>
              <button onClick={() => setShowMethodology(true)}>
                See methodology <ArrowUpRight size={13} />
              </button>
            </div>
            <button className="side-nav-item muted-nav">
              <Settings2 size={17} />
              <span>Settings</span>
            </button>
            <button className="side-nav-item muted-nav">
              <Github size={17} />
              <span>About Prism</span>
            </button>
            <p className="version">
              Prism v0.1.0 <span>·</span> Synthetic data
            </p>
          </div>
        </aside>
        <main className="main-content">
          <div className="content-inner">
            <div className="breadcrumb">
              <span>Workspace</span>
              <ChevronRight size={14} />
              <span>Model cards</span>
              <ChevronRight size={14} />
              <strong>{selectedCard.name}</strong>
            </div>
            <div className="page-heading">
              <div>
                <div className="heading-kicker">
                  <span className="status-dot" />
                  MODEL CARD REVIEW <span className="heading-line" />{" "}
                  <span>
                    LAST RUN{" "}
                    {auditState === "complete" ? "JUST NOW" : "NOT RUN"}
                  </span>
                </div>
                <h1>Model card audit</h1>
                <p>
                  Evidence coverage and review prompts for inclusive, secure AI
                  systems.
                </p>
              </div>
              <div className="heading-actions">
                <button
                  className="button secondary"
                  onClick={() => setShowMethodology(true)}
                >
                  <CircleHelp size={16} />
                  How scoring works
                </button>
                <button
                  className="button primary"
                  onClick={() => setShowExport(true)}
                >
                  <Download size={16} />
                  Export review packet
                </button>
              </div>
            </div>
            <section
              className="audit-selector"
              id="audit-content"
              tabIndex="-1"
            >
              <div className="selector-copy">
                <div className="selector-icon">
                  <FileText size={21} />
                </div>
                <div>
                  <label htmlFor="model-card-select">Model card</label>
                  <p>Choose a bundled synthetic scenario to review</p>
                </div>
              </div>
              <div className="selector-controls">
                <select
                  id="model-card-select"
                  aria-label="Model card"
                  value={selectedId}
                  onChange={(event) => selectCard(event.target.value)}
                >
                  {modelCards.map((card) => (
                    <option key={card.id} value={card.id}>
                      {card.name}
                    </option>
                  ))}
                </select>
                <button
                  className="button run-button"
                  onClick={runAudit}
                  disabled={auditState === "running"}
                >
                  {auditState === "running" ? (
                    <>
                      <span className="spinner" />
                      Running
                    </>
                  ) : (
                    <>
                      <Zap size={16} />
                      Run audit
                    </>
                  )}
                </button>
              </div>
            </section>
            {auditState === "complete" && (
              <div className="complete-banner" role="status">
                <CheckCircle2 size={17} />
                <span>
                  <strong>Audit complete</strong>. Findings are prompts for
                  review, not certification.
                </span>
                <button onClick={() => setActiveTab("overview")}>
                  View summary <ArrowUpRight size={14} />
                </button>
              </div>
            )}
            <div className="model-meta">
              <div className="model-title">
                <div className="model-avatar">
                  {selectedCard.name
                    .split(" ")
                    .map((word) => word[0])
                    .join("")}
                </div>
                <div>
                  <h2>
                    {selectedCard.name}{" "}
                    <span className="version-tag">v{selectedCard.version}</span>
                  </h2>
                  <p>
                    {selectedCard.type} <span>·</span> {selectedCard.owner}
                  </p>
                </div>
              </div>
              <div className="meta-tags">
                <span className="badge purple">Synthetic</span>
                <span className="review-date">
                  Last reviewed {selectedCard.lastReviewed}
                </span>
                <button
                  className="icon-button"
                  aria-label="More model card options"
                >
                  <MoreHorizontal size={19} />
                </button>
              </div>
            </div>
            {route.page === "audit" && (
              <>
                <div
                  className="tabs"
                  role="tablist"
                  aria-label="Audit sections"
                >
                  {tabs.map((tab, index) => (
                    <button
                      key={tab.id}
                      ref={(node) => {
                        tabRefs.current[index] = node;
                      }}
                      role="tab"
                      aria-label={tab.label}
                      aria-selected={activeTab === tab.id}
                      tabIndex={activeTab === tab.id ? 0 : -1}
                      className={`tab ${activeTab === tab.id ? "active" : ""}`}
                      onClick={() => setActiveTab(tab.id)}
                      onKeyDown={(event) => handleTabKey(event, index)}
                    >
                      {tab.label}
                      {tab.id === "fairness" &&
                        audit.findings.some(
                          (finding) => finding.category === "fairness",
                        ) && (
                          <span className="tab-alert" aria-hidden="true">
                            !
                          </span>
                        )}
                    </button>
                  ))}
                </div>
                {activeTab === "overview" && (
                  <Overview
                    audit={audit}
                    card={selectedCard}
                    counts={counts}
                    onNavigate={setActiveTab}
                    onReviewAll={openRiskDashboard}
                    onMethodology={() => setShowMethodology(true)}
                  />
                )}
                {activeTab === "fairness" && (
                  <FairnessPanel audit={audit} card={selectedCard} />
                )}
                {activeTab === "privacy" && (
                  <PrivacyPanel audit={audit} card={selectedCard} />
                )}
                {activeTab === "security" && (
                  <SecurityPanel audit={audit} card={selectedCard} />
                )}
                {activeTab === "accessibility" && (
                  <AccessibilityPanel audit={audit} card={selectedCard} />
                )}
              </>
            )}
            <div id="route-content" tabIndex="-1">
              {route.page === "risk-tradeoffs" && (
                <RiskDashboard
                  card={selectedCard}
                  audit={audit}
                  onPreview={previewPacket}
                />
              )}
              {route.page === "packet-preview" && (
                <PacketPreview
                  card={selectedCard}
                  audit={audit}
                  notes={notes}
                  setNotes={setNotes}
                  onDownload={(packet) =>
                    downloadReviewPacket(selectedId, packet)
                  }
                  onBack={openRiskDashboard}
                />
              )}
            </div>
            <footer className="app-footer">
              <span>
                <ShieldCheck size={14} />
                Local-first review workspace
              </span>
              <span>All model cards and metrics are synthetic.</span>
              <span>
                <Info size={14} />
                Prism is not a safety certification.
              </span>
            </footer>
          </div>
        </main>
      </div>
      {showExport && (
        <ExportModal
          card={selectedCard}
          audit={audit}
          notes={notes}
          setNotes={setNotes}
          onClose={() => setShowExport(false)}
          onDownload={() => setShowExport(false)}
          onPreview={() => {
            setShowExport(false);
            previewPacket();
          }}
        />
      )}
      {showMethodology && (
        <MethodologyModal
          audit={audit}
          card={selectedCard}
          onClose={() => setShowMethodology(false)}
        />
      )}
      {showSearch && (
        <SearchModal
          query={query}
          setQuery={setQuery}
          cards={modelCards}
          onSelect={selectCard}
          onClose={() => setShowSearch(false)}
        />
      )}
    </div>
  );
}

function Overview({
  audit,
  card,
  counts,
  onNavigate,
  onReviewAll,
  onMethodology,
}) {
  const topFindings = audit.findings.slice(0, 3);
  return (
    <>
      <section className="summary-grid">
        <div className="score-card">
          <div className="card-label">
            EVIDENCE COVERAGE{" "}
            <button
              className="info-button"
              aria-label="Coverage score information"
              onClick={onMethodology}
            >
              <Info size={14} />
            </button>
          </div>
          <div className="score-row">
            <strong>
              {audit.coverage}
              <span>%</span>
            </strong>
            <div
              className="score-ring"
              style={{ "--score": `${audit.coverage}%` }}
            >
              <div>
                {audit.coverage}
                <small>/100</small>
              </div>
            </div>
          </div>
          <p>Documented checks across five audit dimensions.</p>
          <button className="text-link" onClick={onMethodology}>
            How is this calculated? <ArrowUpRight size={13} />
          </button>
        </div>
        <div className="findings-card">
          <div className="card-label">
            REVIEW FINDINGS{" "}
            <span className="finding-count">{audit.findings.length}</span>
            <span className="card-label-right">
              {counts.high > 0 ? "Needs attention" : "No high-risk flags"}
            </span>
          </div>
          <div className="finding-summary">
            <div className="finding-stat high">
              <strong>{counts.high}</strong>
              <span>High</span>
            </div>
            <div className="finding-stat medium">
              <strong>{counts.medium}</strong>
              <span>Medium</span>
            </div>
            <div className="finding-stat low">
              <strong>{counts.low}</strong>
              <span>Low</span>
            </div>
            <div className="finding-bar">
              <span
                style={{
                  width: `${Math.max(3, (counts.high / Math.max(audit.findings.length, 1)) * 100)}%`,
                }}
              />
              <span
                style={{
                  width: `${Math.max(3, (counts.medium / Math.max(audit.findings.length, 1)) * 100)}%`,
                }}
              />
              <span
                style={{
                  width: `${Math.max(3, (counts.low / Math.max(audit.findings.length, 1)) * 100)}%`,
                }}
              />
            </div>
          </div>
          <p className="finding-note">
            {counts.high > 0
              ? "Start with high-priority evidence gaps and policy contradictions."
              : "No high-priority prompts in the current audit."}
          </p>
          <button className="text-link" onClick={onReviewAll}>
            Review all findings <ArrowUpRight size={13} />
          </button>
        </div>
      </section>
      <section className="section-block">
        <div className="section-heading">
          <div>
            <h2>Coverage by dimension</h2>
            <p>
              What is documented in this model card—not a model quality score.
            </p>
          </div>
          <button className="button ghost" onClick={onMethodology}>
            <CircleHelp size={15} />
            Scoring guide
          </button>
        </div>
        <div className="dimension-grid">
          {audit.dimensions.map((item) => (
            <button
              className="dimension-card"
              key={item.id}
              onClick={() =>
                onNavigate(
                  item.id === "documentation"
                    ? "overview"
                    : item.id === "fairness"
                      ? "fairness"
                      : item.id === "privacy"
                        ? "privacy"
                        : item.id === "security"
                          ? "security"
                          : "accessibility",
                )
              }
            >
              <div className="dimension-top">
                <span className={`dimension-icon ${scoreClass(item.score)}`}>
                  {item.id === "documentation" ? (
                    <FileCheck2 size={17} />
                  ) : item.id === "fairness" ? (
                    <Users size={17} />
                  ) : item.id === "privacy" ? (
                    <LockKeyhole size={17} />
                  ) : item.id === "security" ? (
                    <ShieldCheck size={17} />
                  ) : (
                    <Keyboard size={17} />
                  )}
                </span>
                <ChevronRight size={16} className="dim-arrow" />
              </div>
              <strong>{item.label}</strong>
              <div className="dimension-score">
                <b>{item.score}%</b>
                <span>
                  {item.covered}/{item.total} checks
                </span>
              </div>
              <div className="progress">
                <span
                  className={scoreClass(item.score)}
                  style={{ width: `${item.score}%` }}
                />
              </div>
            </button>
          ))}
        </div>
      </section>
      <section className="section-block lower-grid">
        <div className="panel">
          <div className="section-heading compact">
            <div>
              <h2>Subgroup snapshot</h2>
              <p>Descriptive accuracy across expected groups.</p>
            </div>
            <button
              className="text-link"
              onClick={() => onNavigate("fairness")}
            >
              See full analysis <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="metric-highlight">
            <div>
              <strong>
                {card.metrics.length ? audit.fairnessGap : "—"}
                <span>pp</span>
              </strong>
              <small>Observed accuracy gap</small>
            </div>
            <div
              className={`mini-alert ${audit.fairnessGap > 5 ? "warn" : "ok"}`}
            >
              <TriangleAlert size={15} />
              {audit.fairnessGap > 5
                ? "Above 5pp review threshold"
                : "Within review threshold"}
            </div>
          </div>
          <div className="mini-table">
            <div className="table-head">
              <span>GROUP</span>
              <span>ACCURACY</span>
              <span>FPR</span>
            </div>
            {audit.subgroups.slice(0, 4).map((metric) => (
              <div
                className="table-row"
                key={`${metric.group}-${metric.sampleSize}`}
              >
                <span>{metric.group}</span>
                <strong>{metric.accuracy}%</strong>
                <span>{metric.falsePositiveRate}%</span>
              </div>
            ))}
            {card.expectedSubgroups
              .filter(
                (group) =>
                  !audit.subgroups.some((metric) => metric.group === group),
              )
              .slice(0, 1)
              .map((group) => (
                <div className="table-row missing" key={group}>
                  <span>{group}</span>
                  <strong>—</strong>
                  <span>Missing</span>
                </div>
              ))}
          </div>
        </div>
        <div className="panel">
          <div className="section-heading compact">
            <div>
              <h2>Top review prompts</h2>
              <p>Start with the highest-impact gaps.</p>
            </div>
            <button
              className="text-link"
              onClick={onReviewAll}
            >
              View all <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="prompt-list">
            {topFindings.map((finding) => (
              <button
                key={finding.id}
                className="prompt-item"
                onClick={() =>
                  finding.category === "claims" ? onReviewAll() : onNavigate(finding.category)
                }
              >
                <span className={`severity-dot ${finding.severity}`} />
                <span>
                  <strong>{finding.title}</strong>
                  <small>
                    {finding.category} <span>·</span> {finding.severity}{" "}
                    priority
                  </small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
            {!topFindings.length && (
              <div className="empty-message">
                <CheckCircle2 size={18} />
                No review prompts generated.
              </div>
            )}
          </div>
        </div>
      </section>
      <section className="callout purple-callout">
        <div className="callout-icon">
          <Sparkles size={18} />
        </div>
        <div>
          <strong>Review every flag with its evidence</strong>
          <p>
            Compare illustrative strategies and inspect the metrics, policies,
            threats, and access checks behind each flag.
          </p>
        </div>
        <button onClick={onReviewAll}>
          Open risk dashboard <ArrowUpRight size={14} />
        </button>
      </section>
    </>
  );
}

function PanelHeader({ eyebrow, title, description, children }) {
  return (
    <div className="panel-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}
function StatStrip({ items }) {
  return (
    <div className="stat-strip">
      {items.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <strong className={item.className || ""}>{item.value}</strong>
          <small>{item.detail}</small>
        </div>
      ))}
    </div>
  );
}
function FindingCallout({ finding }) {
  return finding ? <FindingEvidence finding={finding} /> : null;
}

function FairnessPanel({ audit, card }) {
  const missing = card.expectedSubgroups.filter(
    (group) => !audit.subgroups.some((metric) => metric.group === group && validMetric(metric)),
  );
  const gapFinding = findingFor(audit, "fairness-accuracy-gap");
  return (
    <section className="detail-page">
      <PanelHeader
        eyebrow="DIMENSION 02 · FAIRNESS"
        title="Subgroup fairness"
        description="Make performance differences visible before they become deployment surprises."
      >
        <span className="score-pill">
          <strong>
            {audit.dimensions.find((item) => item.id === "fairness")?.score}%
          </strong>{" "}
          coverage
        </span>
      </PanelHeader>
      <StatStrip
        items={[
          {
            label: "ACCURACY GAP",
            value: `${audit.fairnessGap}pp`,
            detail:
              audit.fairnessGap > 5
                ? "Review threshold: 5pp"
                : "Within review threshold",
            className: audit.fairnessGap > 5 ? "orange" : "green",
          },
          {
            label: "EXPECTED GROUPS",
            value: card.expectedSubgroups.length,
            detail: `${missing.length} missing`,
          },
          {
            label: "VALID METRICS",
            value: new Set(audit.subgroups.filter(validMetric).map((metric) => metric.group)).size,
            detail: "Valid named groups",
          },
        ]}
      />
      <FindingCallout finding={findingFor(audit, "fairness-missing-data")} />
      <FindingCallout finding={gapFinding} />
      <FindingCallout finding={findingFor(audit, "fairness-small-samples")} />
      <div className="detail-panel">
        <div className="section-heading compact">
          <div>
            <h3>Subgroup evaluation table</h3>
            <p>Accuracy and false-positive rate from the bundled card.</p>
          </div>
          <span className="badge neutral">Evidence-only</span>
        </div>
        <div className="full-table" role="table" aria-label="Subgroup evaluation">
          <div className="full-table-head" role="row">
            <span role="columnheader">EXPECTED GROUP</span>
            <span role="columnheader">SAMPLE</span>
            <span role="columnheader">ACCURACY</span>
            <span role="columnheader">FALSE-POSITIVE RATE</span>
            <span role="columnheader">STATUS</span>
          </div>
          {[
            ...new Set([
              ...card.expectedSubgroups,
              ...audit.subgroups.map((metric) => metric.group),
            ]),
          ].map((group) => {
            const metric = audit.subgroups.find((item) => item.group === group && validMetric(item));
            const valid = validMetric(metric);
            return (
              <div className="full-table-row" role="row" key={group}>
                <span role="rowheader">
                  <strong>{group}</strong>
                </span>
                <span role="cell" data-label="Sample">
                  <span className="table-cell-label" aria-hidden="true">Sample</span>
                  <span>{valid ? metric.sampleSize : "—"}</span>
                </span>
                <span role="cell" data-label="Accuracy">
                  <span className="table-cell-label" aria-hidden="true">Accuracy</span>
                  <span>{valid ? `${metric.accuracy}%` : "—"}</span>
                </span>
                <span role="cell" data-label="False-positive rate">
                  <span className="table-cell-label" aria-hidden="true">False-positive rate</span>
                  <span>{valid ? `${metric.falsePositiveRate}%` : "—"}</span>
                </span>
                <span
                  role="cell"
                  data-label="Status"
                  className={
                    valid
                      ? metric.sampleSize < 30
                        ? "status-warn"
                        : "status-pass"
                      : "status-risk"
                  }
                >
                  <span className="table-cell-label" aria-hidden="true">Status</span>
                  <span>
                    {valid
                      ? metric.sampleSize < 30
                        ? "Small sample"
                        : "Documented"
                      : "Missing data"}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <TradeoffPanel card={card} />
    </section>
  );
}

function PrivacyPanel({ audit, card }) {
  const privacy = audit.dimensions.find((item) => item.id === "privacy");
  const contradiction = findingFor(audit, "privacy-consent-conflict");
  return (
    <section className="detail-page">
      <PanelHeader
        eyebrow="DIMENSION 03 · DATA & PRIVACY"
        title="Data use & consent"
        description="Consent should be legible, scoped, and internally consistent."
      >
        <span className="score-pill">
          <strong>{privacy?.score}%</strong> coverage
        </span>
      </PanelHeader>
      <StatStrip
        items={[
          {
            label: "RETENTION",
            value: `${card.dataUse.retentionDays}d`,
            detail: "Documented policy",
          },
          {
            label: "CONSENT SCOPES",
            value: card.dataUse.statements.length,
            detail: "Training · evaluation · retention",
          },
          {
            label: "CONTRADICTIONS",
            value: audit.findings.filter(
              (item) => item.id === "privacy-consent-conflict",
            ).length,
            detail: "Needs reconciliation",
            className: contradiction ? "orange" : "green",
          },
        ]}
      />
      <FindingCallout finding={contradiction} />
      <FindingCallout finding={findingFor(audit, "privacy-missing-data")} />
      <div className="detail-panel">
        <div className="section-heading compact">
          <div>
            <h3>Policy statements</h3>
            <p>
              Structured flags and bounded language checks are compared
              together.
            </p>
          </div>
          <span className="badge neutral">
            {card.dataUse.statements.length} statements
          </span>
        </div>
        <div className="statement-list">
          {card.dataUse.statements.map((statement) => (
            <div className="statement-row" key={statement.id}>
              <div className="statement-scope">{statement.scope}</div>
              <div className="statement-body">
                <p>{statement.text}</p>
                <small>
                  requiresConsent:{" "}
                  <strong>{String(statement.requiresConsent)}</strong>
                </small>
              </div>
              <span
                className={`consent-tag ${statement.requiresConsent ? "yes" : "no"}`}
              >
                {statement.requiresConsent
                  ? "Consent required"
                  : "No consent flag"}
              </span>
            </div>
          ))}
        </div>
        <div className="policy-fields">
          <div>
            <span>COLLECTION</span>
            <strong>{card.dataUse.collection}</strong>
          </div>
          <div>
            <span>SENSITIVE ATTRIBUTES</span>
            <strong>{card.dataUse.sensitiveAttributes}</strong>
          </div>
        </div>
      </div>
      <TradeoffPanel card={card} />
    </section>
  );
}

function SecurityPanel({ audit, card }) {
  const security = audit.dimensions.find((item) => item.id === "security");
  return (
    <section className="detail-page">
      <PanelHeader
        eyebrow="DIMENSION 04 · SECURITY"
        title="Threat assessment"
        description="Surface threat scenarios and the mitigations a reviewer can actually inspect."
      >
        <span className="score-pill">
          <strong>{security?.score}%</strong> coverage
        </span>
      </PanelHeader>
      <StatStrip
        items={[
          {
            label: "THREATS",
            value: card.threats.length,
            detail: "Documented scenarios",
          },
          {
            label: "MITIGATED",
            value: card.threats.filter(
              (threat) => threat.status === "mitigated",
            ).length,
            detail: "Self-reported status",
            className: "green",
          },
          {
            label: "OPEN",
            value: card.threats.filter(
              (threat) => threat.status !== "mitigated",
            ).length,
            detail: "Needs owner or action",
            className: card.threats.some(
              (threat) => threat.status !== "mitigated",
            )
              ? "orange"
              : "green",
          },
        ]}
      />
      <FindingCallout finding={findingFor(audit, "security-unmitigated")} />
      <div className="threat-grid">
        {card.threats.map((threat) => (
          <div className="threat-card" key={threat.id}>
            <div className="threat-card-top">
              <span className={`severity-badge ${threat.severity}`}>
                {threat.severity} severity
              </span>
              <span className={`threat-status ${threat.status}`}>
                {threat.status === "mitigated" ? (
                  <Check size={13} />
                ) : (
                  <AlertTriangle size={13} />
                )}
                {threat.status}
              </span>
            </div>
            <h3>{threat.name}</h3>
            <p>{threat.mitigation}</p>
            <div className="threat-footer">
              <span>{threat.id}</span>
              <span>Scenario coverage</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AccessibilityPanel({ audit, card }) {
  const accessibility = audit.dimensions.find(
    (item) => item.id === "accessibility",
  );
  return (
    <section className="detail-page">
      <PanelHeader
        eyebrow="DIMENSION 05 · ACCESSIBILITY"
        title="Accessibility checks"
        description="Access needs belong in the model-card evidence, not just the interface."
      >
        <span className="score-pill">
          <strong>{accessibility?.score}%</strong> coverage
        </span>
      </PanelHeader>
      <StatStrip
        items={[
          {
            label: "CHECKS",
            value: card.accessibility.length,
            detail: "Recorded checks",
          },
          {
            label: "PASS",
            value: card.accessibility.filter((check) => check.status === "pass")
              .length,
            detail: "Documented pass",
            className: "green",
          },
          {
            label: "GAPS",
            value: card.accessibility.filter((check) => check.status !== "pass")
              .length,
            detail: "Fail or not tested",
            className: card.accessibility.some(
              (check) => check.status !== "pass",
            )
              ? "orange"
              : "green",
          },
        ]}
      />
      <FindingCallout finding={findingFor(audit, "accessibility-failed")} />
      <FindingCallout finding={findingFor(audit, "accessibility-missing")} />
      <div className="detail-panel">
        <div className="section-heading compact">
          <div>
            <h3>Check record</h3>
            <p>
              Statuses are self-reported and should be repeated with relevant
              users and tools.
            </p>
          </div>
          <span className="badge neutral">Keyboard-first</span>
        </div>
        <div className="access-checks">
          {card.accessibility.map((check) => (
            <div className="access-row" key={check.id}>
              <div className={`access-status ${check.status}`}>
                {check.status === "pass" ? (
                  <Check size={17} />
                ) : check.status === "fail" ? (
                  <X size={17} />
                ) : (
                  <CircleHelp size={17} />
                )}
              </div>
              <div>
                <strong>{check.name}</strong>
                <p>{check.detail}</p>
              </div>
              <span className={`status-pill ${check.status}`}>
                {check.status}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="keyboard-note">
        <Keyboard size={19} />
        <div>
          <strong>Keyboard-only flow included</strong>
          <p>
            Prism’s review workflow is designed to be operable without a
            pointer. Use Tab to move through controls, arrow keys in tabs, and
            Enter or Space to activate.
          </p>
        </div>
      </div>
    </section>
  );
}

function TradeoffPanel({ card }) {
  return (
    <div className="tradeoff-panel">
      <div className="section-heading compact">
        <div>
          <h3>Privacy ↔ fairness trade-off</h3>
          <p>Illustrative strategies bundled with this synthetic card.</p>
        </div>
        <span className="badge neutral">Not a score input</span>
      </div>
      <div className="tradeoff-grid">
        {card.tradeoffs.map((tradeoff) => (
          <div
            className={`tradeoff-card ${tradeoff.current ? "current" : ""}`}
            key={tradeoff.id}
          >
            <div className="tradeoff-top">
              <strong>{tradeoff.name}</strong>
              {tradeoff.current && (
                <span className="badge purple">Current</span>
              )}
            </div>
            <p>{tradeoff.description}</p>
            <div className="tradeoff-bars">
              <span>
                <small>Privacy risk</small>
                <i>
                  <b style={{ width: `${tradeoff.privacyRisk}%` }} />
                </i>
              </span>
              <span>
                <small>Fairness visibility</small>
                <i>
                  <b
                    className="fairness-bar"
                    style={{ width: `${tradeoff.fairnessVisibility}%` }}
                  />
                </i>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
