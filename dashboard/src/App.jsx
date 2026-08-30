import { useEffect, useState, useCallback } from 'react';

const api = async (path, body) => {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
};

const LABEL = {
  found: 'found', working: 'working', 'needs-answer': 'needs you',
  'awaiting-approval': 'awaiting you', submitted: 'submitted',
  blocked: 'blocked', ready: 'ready', starting: 'starting',
};

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [profile, setProfile] = useState(null);
  const [selId, setSelId] = useState(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('application');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api('/api/state');
      setJobs(s.jobs);
      setProfile(s.profile);
    } catch { /* backend may be restarting */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const sel = jobs.find((j) => j.id === selId) ?? null;

  const addJob = async () => {
    if (!query.trim()) return;
    const isUrl = /^https?:\/\//i.test(query.trim());
    const { job } = await api('/api/jobs', isUrl ? { url: query.trim() } : { query: query.trim() });
    setQuery('');
    setSelId(job.id);
    refresh();
  };

  const act = async (path, body) => {
    setBusy(true);
    try { await api(path, body); await refresh(); }
    catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  const startable = jobs.filter((j) => (j.live?.status ?? 'found') === 'found');

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <h1>Dossier</h1>
          <p>applies the way each company requires</p>
        </div>

        <div className="add">
          <input
            placeholder="backend engineer at Ramp"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addJob()}
          />
          <div className="add-row">
            <button className="btn primary" onClick={addJob} disabled={!query.trim()}>Add</button>
            <button
              className="btn"
              disabled={!startable.length || busy}
              onClick={() => startable.forEach((j) => act('/api/jobs/start', { id: j.id }))}
            >
              Start all ({startable.length})
            </button>
          </div>
        </div>

        <div className="jobs">
          {!jobs.length && <div style={{ padding: 20, color: 'var(--dim)', fontSize: 13 }}>
            Name a job to get started. No URL needed.
          </div>}
          {jobs.map((j) => {
            const st = j.live?.status ?? 'found';
            return (
              <div key={j.id} className={`job${j.id === selId ? ' sel' : ''}`} onClick={() => setSelId(j.id)}>
                <div className="job-title">{j.title}</div>
                {j.company && <div className="job-co">{j.company}</div>}
                <div className="job-foot">
                  <span className={`pill ${st}`}>{LABEL[st] ?? st}</span>
                  {st === 'found' && (
                    <button className="btn ghost" style={{ padding: '3px 10px', fontSize: 12 }}
                      onClick={(e) => { e.stopPropagation(); act('/api/jobs/start', { id: j.id }); }}>
                      Start
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <main className="pane">
        {!sel ? (
          <div className="empty">
            <div>
              <div style={{ fontSize: 15, marginBottom: 6 }}>No application selected</div>
              <div style={{ fontSize: 13 }}>Add a job on the left, then press Start.</div>
            </div>
          </div>
        ) : (
          <Detail job={sel} profile={profile} tab={tab} setTab={setTab} act={act} busy={busy} refresh={refresh} />
        )}
      </main>
    </div>
  );
}

function Detail({ job, profile, tab, setTab, act, busy, refresh }) {
  const live = job.live ?? {};
  const [answer, setAnswer] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => { setAnswer(''); setReason(''); }, [job.id, live.pendingToolCallId]);

  return (
    <>
      <div className="head">
        <h2>{job.title}</h2>
        <div className="sub">{job.url ?? job.query}</div>
      </div>

      <div className="tabs">
        {['application', 'resume'].map((t) => (
          <button key={t} className={`tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
            {t === 'application' ? 'Application' : 'Résumé'}
          </button>
        ))}
      </div>

      {tab === 'resume'
        ? <ResumePanel profile={profile} refresh={refresh} />
        : (
          <>
            <div className="meta">
              <div><span className="k">Status</span><span className="v">{LABEL[live.status] ?? live.status ?? 'found'}</span></div>
              {live.steps?.length ? <div><span className="k">Steps</span><span className="v">{live.steps.length}</span></div> : null}
            </div>

            {live.status === 'needs-answer' && live.question && (
              <div className="card ask">
                <h3>The agent needs an answer</h3>
                <div className="q">{live.question.text}</div>
                {live.question.options?.length > 0 && (
                  <div className="opts">
                    {live.question.options.map((o) => (
                      <button key={o} className="opt" onClick={() => setAnswer(o)}>{o}</button>
                    ))}
                  </div>
                )}
                <div className="answer-row">
                  <input value={answer} onChange={(e) => setAnswer(e.target.value)}
                    placeholder="Your answer…"
                    onKeyDown={(e) => e.key === 'Enter' && answer.trim() &&
                      act('/api/jobs/answer', { id: job.id, threadId: live.threadId, toolCallId: live.pendingToolCallId, content: answer })} />
                  <button className="btn primary" disabled={!answer.trim() || busy}
                    onClick={() => act('/api/jobs/answer', { id: job.id, threadId: live.threadId, toolCallId: live.pendingToolCallId, content: answer })}>
                    Send
                  </button>
                </div>
              </div>
            )}

            {live.status === 'awaiting-approval' && (
              <div className="card gate">
                <h3>Held for your approval</h3>
                <div className="q">
                  The agent has filled this application and is waiting to submit it.
                  <strong> Nothing has been sent.</strong>
                </div>
                <div className="warn">Submitting is irreversible — an application cannot be recalled.</div>
                <div className="reason" style={{ marginTop: 12 }}>
                  <input value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason, if you're sending it back…" style={{ width: '100%' }} />
                </div>
                <div className="gate-actions">
                  <button className="btn primary" disabled={busy}
                    onClick={() => act('/api/jobs/approve', { id: job.id, threadId: live.threadId, toolCallId: live.pendingToolCallId })}>
                    Approve &amp; submit
                  </button>
                  <button className="btn danger" disabled={busy}
                    onClick={() => act('/api/jobs/deny', { id: job.id, threadId: live.threadId, toolCallId: live.pendingToolCallId, reason: reason || 'denied by user' })}>
                    Send back
                  </button>
                </div>
              </div>
            )}

            {live.steps?.length > 0 && (
              <div className="card">
                <h3>What the agent did</h3>
                <div className="steps">
                  {live.steps.map((s, i) => (
                    <div key={s.id ?? i} className="step"><span className="dot" />{s.label}</div>
                  ))}
                </div>
              </div>
            )}

            {live.output && (
              <div className="card">
                <h3>Agent report</h3>
                <div className="out">{live.output}</div>
              </div>
            )}
          </>
        )}
    </>
  );
}

function ResumePanel({ profile, refresh }) {
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState('');

  const send = async () => {
    if (!prompt.trim()) return;
    setRunning(true); setResult('');
    try {
      const { sessionId, turnId } = await api('/api/profile/prompt', { prompt });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await api(`/api/profile/status?session=${sessionId}&turn=${turnId}`);
        if (['done', 'failed', 'error'].includes(s.status)) { setResult(s.output || '(no output)'); break; }
      }
      setPrompt('');
      refresh();
    } catch (e) { setResult(`Error: ${e.message}`); }
    finally { setRunning(false); }
  };

  if (!profile) return <div className="card">No profile loaded.</div>;

  return (
    <>
      <div className="card">
        <h3>Ask for a change</h3>
        <div className="resume-prompt">
          <input value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="add Terraform to my skills — or — add a bullet at Meridian about cutting cloud spend"
            onKeyDown={(e) => e.key === 'Enter' && send()} disabled={running} />
          <button className="btn primary" onClick={send} disabled={running || !prompt.trim()}>
            {running ? 'Working…' : 'Apply'}
          </button>
        </div>
        <div className="warn" style={{ color: 'var(--dim)' }}>
          The agent only makes changes you ask for. It will not add skills on its own to improve a match.
        </div>
        {result && <div className="out" style={{ marginTop: 14 }}>{result}</div>}
      </div>

      <div className="card">
        <h3>Skills</h3>
        <div className="chips">{(profile.skills ?? []).map((s) => <span key={s} className="chip">{s}</span>)}</div>
      </div>

      {(profile.experience ?? []).map((e) => (
        <div className="card" key={e.company}>
          <h3>{e.company} — {e.title}</h3>
          <div className="steps">
            {(e.bullets ?? []).map((b, i) => (
              <div key={i} className="step" style={{ alignItems: 'flex-start' }}>
                <span className="dot" style={{ marginTop: 7 }} />{b}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
