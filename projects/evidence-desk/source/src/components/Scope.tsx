import { EVIDENCE_DESK_SCOPE } from '../scope'
import { Badge, Icon } from './Primitives'

export function ScopeBanner({ compact = false }: { compact?: boolean }) {
  return <aside className={`scope-banner ${compact ? 'scope-banner-compact' : ''}`} aria-label="Synthetic case and no-contact scope">
    <div className="scope-banner-mark"><Icon name="shield" /></div>
    <div className="scope-banner-copy"><div><Badge tone="purple">{EVIDENCE_DESK_SCOPE.badge}</Badge><strong>{EVIDENCE_DESK_SCOPE.label}</strong><span className="scope-no-contact">{EVIDENCE_DESK_SCOPE.short}</span></div>{!compact && <p>{EVIDENCE_DESK_SCOPE.description}</p>}</div>
  </aside>
}
