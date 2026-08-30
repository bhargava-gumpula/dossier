import { useState, useRef, useEffect } from 'react';

// The opening surface: one large input in the middle, the way a terminal agent
// opens with a prompt and nothing else. Naming a company is the whole interface.

export function Composer({ onSubmit, busy, compact }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const send = () => {
    const v = text.trim();
    if (!v || busy) return;
    onSubmit(v);
    setText('');
  };

  return (
    <div className={`composer${compact ? ' compact' : ''}`}>
      {!compact && (
        <>
          <h2 className="composer-h">What do you want to apply to?</h2>
          <p className="composer-sub">
            Name a company. Add a role if you have one in mind.
          </p>
        </>
      )}
      <div className="composer-box">
        <span className="composer-caret">›</span>
        <input
          ref={ref}
          value={text}
          disabled={busy}
          placeholder="Nutanix — or — backend engineer at Ramp"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button className="btn primary" onClick={send} disabled={busy || !text.trim()}>
          {busy ? 'Looking…' : 'Find roles'}
        </button>
      </div>
      {!compact && (
        <div className="composer-hint">
          Works for any company. Boards that publish a listing are read directly;
          everyone else is found by searching their own careers site.
        </div>
      )}
    </div>
  );
}

// Roles the company is actually hiring for. Selecting is the point: applying to
// the wrong requisition is not recoverable, so the human chooses. Choosing
// nothing hands the judgement to the agent explicitly, rather than by default.
export function PositionPicker({ result, onQueue, onBack, busy }) {
  const [sel, setSel] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const positions = result.positions ?? [];

  const toggle = (k) =>
    setSel((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const chosen = positions.filter((p) => sel.has(p.key));

  if (!result.found || !positions.length) {
    return (
      <div className="picker">
        <button className="btn ghost back" onClick={onBack}>← Back</button>
        <h2 className="picker-h">No roles found at {result.company}</h2>
        <p className="picker-sub">{result.note}</p>
        {result.careersUrl && (
          <p className="picker-sub">
            Their careers site is <a href={result.careersUrl} target="_blank" rel="noreferrer">{result.careersUrl}</a>.
            Paste a job URL and everything after that works the same.
          </p>
        )}
      </div>
    );
  }

  const bestFits = result.bestFits ?? [];
  const ranked = result.matchedAgainstResume && bestFits.length;
  const bestKeys = new Set(bestFits.map((p) => p.key));
  const rest = ranked ? positions.filter((p) => !bestKeys.has(p.key)) : positions;

  const row = (p) => (
    <label key={p.key} className={`position${sel.has(p.key) ? ' on' : ''}`}>
      <input type="checkbox" checked={sel.has(p.key)} onChange={() => toggle(p.key)} />
      <span className="position-body">
        <span className="position-title">{p.title}</span>
        {p.location && <span className="position-loc">{p.location}</span>}
        {p.reasons?.length > 0 && (
          <span className="position-why">
            {p.reasons.map((r) => <span key={r} className="why-chip">{r}</span>)}
          </span>
        )}
      </span>
    </label>
  );

  // Handing the whole board to the agent would open a session per posting, so
  // the agent is only ever offered the short list.
  const agentPicks = ranked ? bestFits : positions.slice(0, 5);

  return (
    <div className="picker">
      <button className="btn ghost back" onClick={onBack}>← Back</button>
      <h2 className="picker-h">{positions.length} roles at {result.company}</h2>
      <p className="picker-sub">
        Read from {result.source === 'web-search' ? 'their careers site' : result.source}.
        {ranked
          ? ' Ranked against your résumé — the skills, titles and seniority actually on it.'
          : ' Pick the ones you want. Pick none and the agent chooses the roles you fit best.'}
      </p>

      {ranked ? (
        <>
          <h3 className="picker-group">Best fits for your résumé</h3>
          <div className="position-list">{bestFits.map(row)}</div>
          <p className="picker-fine">
            Matched on job titles, not full descriptions — reading every posting would be
            one request per role. Nothing is hidden: the rest of the board is below.
          </p>

          <button className="btn ghost more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? '− Hide' : `+ Show all ${positions.length} roles at ${result.company}`}
          </button>
          {showAll && <div className="position-list">{rest.map(row)}</div>}
        </>
      ) : (
        <div className="position-list">{positions.map(row)}</div>
      )}

      <div className="picker-actions">
        <button className="btn primary" disabled={busy || !chosen.length}
          onClick={() => onQueue(chosen, false)}>
          {chosen.length ? `Apply to ${chosen.length} selected` : 'Apply to selected'}
        </button>
        <button className="btn" disabled={busy || !agentPicks.length}
          onClick={() => onQueue(agentPicks, true)}>
          Let the agent choose from {agentPicks.length === 1 ? 'this role' : `these ${agentPicks.length}`}
        </button>
      </div>
    </div>
  );
}
