import { useId, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { exportReviewPacket } from '../lib/audit.js';
import './packet-preview.css';

// Markdown references remain readable without creating navigation or requests.
const markdownComponents = {
  a: ({ children }) => <span className="packet-preview-reference">{children}</span>,
  img: ({ alt }) => <span className="packet-preview-reference">{alt || 'Image omitted'}</span>,
  table: ({ children }) => (
    <div className="packet-preview-table-scroll" role="group" aria-label="Scrollable packet table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export default function PacketPreview({ card, audit, notes, setNotes, onDownload, onBack }) {
  const headingId = useId();
  const notesId = useId();
  const notesHelpId = useId();
  const packet = useMemo(() => exportReviewPacket(card, audit, notes), [card, audit, notes]);

  return (
    <section className="packet-preview" aria-labelledby={headingId}>
      <header className="packet-preview-header">
        <div>
          <h2 id={headingId}>Review packet preview</h2>
          <p className="packet-preview-model"><strong>{card.name}</strong> · v{card.version}</p>
          <p className="packet-preview-intro">Read the complete review packet before downloading the same Markdown snapshot.</p>
        </div>
        <div className="packet-preview-actions">
          <button type="button" className="button secondary" onClick={onBack}>Back to risk dashboard</button>
          <button type="button" className="button primary" onClick={() => onDownload(packet)}>Download Markdown</button>
        </div>
      </header>

      <div className="packet-preview-notice">
        <strong>Synthetic data · Local only · Not a safety certification</strong>
        <p>All bundled model cards, metrics, and evidence are fictional. This preview is generated in your browser; nothing is uploaded, and no remote evidence is fetched or verified.</p>
      </div>

      <div className="packet-preview-notes">
        <label htmlFor={notesId}>Reviewer notes <span>Optional</span></label>
        <textarea
          id={notesId}
          aria-label="Reviewer notes"
          aria-describedby={notesHelpId}
          rows={4}
          value={notes ?? ''}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Add context, decisions, or next steps for your review…"
        />
        <p id={notesHelpId}>Notes update the preview and download immediately. They are kept only in memory for this model card. Reloading the page clears reviewer notes.</p>
      </div>

      <div className="packet-preview-content" role="region" aria-label="Review packet content" tabIndex={0}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>
          {packet}
        </ReactMarkdown>
      </div>
    </section>
  );
}
