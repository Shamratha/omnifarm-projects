import { getThreatFixtures } from '../data/threatFixtures.js';
import './explanations.css';

function TextBlock({ label, children }) {
  return <div className="explanation-panel__text-block">
    <h4>{label}</h4>
    <p>{children}</p>
  </div>;
}

/** Show inert, fictional narratives alongside the bundled threat they describe. */
export default function ThreatFixturesPanel({ card }) {
  const fixtures = getThreatFixtures(card);
  const isSynthetic = card?.synthetic === true;

  return <section className="explanation-panel threat-fixtures-panel"
    aria-label="Synthetic threat fixtures">
    <header className="explanation-panel__header">
      <div>
        <p className="explanation-panel__eyebrow">MANUAL REVIEW CONTEXT</p>
        <h3>Synthetic threat fixtures</h3>
        <p>Inert, fictional narratives that help a reviewer discuss the bundled threat scenarios.</p>
      </div>
    </header>
    <p className="explanation-panel__notice" role="note">
      Not executed: these fixture descriptions are narrative-only input examples. They do not call a model,
      contact an endpoint, run commands, perform live red teaming, produce test results, or affect audit scoring.
      Expected behavior is a human reviewer expectation, not an observed result. Bundled threat statuses are self-reported.
    </p>
    {!fixtures.length ? <p className="explanation-panel__empty">
      {isSynthetic
        ? 'No synthetic threat fixtures are bundled for this card’s documented threats.'
        : 'Synthetic threat fixtures are available only for explicitly synthetic model cards; none are shown for this card.'}
    </p> : <div className="explanation-panel__details">
      {fixtures.map((fixture) => {
        const threat = card.threats.find((item) => item?.id === fixture.threatId);
        return <details className="explanation-panel__detail" key={fixture.id}>
          <summary>
            <span>{fixture.title}</span>
            <code>{fixture.id} · {fixture.threatId}</code>
          </summary>
          <div className="explanation-panel__detail-body">
            <div className="explanation-panel__meta" aria-label={`Bundled threat ${fixture.threatId}`}>
              <h4>Bundled threat: {threat?.name || fixture.threatId}</h4>
              {threat ? <dl>
                <div><dt>Threat ID</dt><dd><code>{threat.id}</code></dd></div>
                <div><dt>Severity</dt><dd><span className={`explanation-panel__badge ${threat.severity}`}>{threat.severity}</span></dd></div>
                <div><dt>Status</dt><dd><span className={`explanation-panel__badge ${threat.status}`}>{threat.status}</span></dd></div>
                <div><dt>Mitigation</dt><dd>{threat.mitigation}</dd></div>
              </dl> : <p>Bundled threat record is not available for this fixture.</p>}
            </div>
            <TextBlock label="Setup">{fixture.setup}</TextBlock>
            <div className="explanation-panel__text-block">
              <h4>Input example</h4>
              <pre>{fixture.input}</pre>
            </div>
            <TextBlock label="Expected behavior">{fixture.expectedBehavior}</TextBlock>
            <TextBlock label="Why this fixture matters">{fixture.explanation}</TextBlock>
            <TextBlock label="Manual review check">{fixture.reviewCheck}</TextBlock>
          </div>
        </details>;
      })}
    </div>}
  </section>;
}
