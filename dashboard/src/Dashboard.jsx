import { useEffect, useState, useCallback } from 'react';
import { Composer, PositionPicker } from './Composer.jsx';

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
  failed: 'failed', 'not-submitted': 'not submitted',
};

export default function Dashboard({ onHome }) {
  const [jobs, setJobs] = useState([]);
  const [profile, setProfile] = useState(null);
  const [selId, setSelId] = useState(null);
  const [tab, setTab] = useState('application');
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(null);   // company -> roles, awaiting choice
  const [view, setView] = useState('compose');  // compose | picker | job

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

  // "backend engineer at Ramp" -> role + company. A bare name is just a company.
  const parse = (text) => {
    const m = text.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
    return m ? { role: m[1].trim(), company: m[2].trim() } : { company: text.trim(), role: null };
  };

  const compose = async (text) => {
    setBusy(true);
    try {
      if (/^https?:\/\//i.test(text)) {
        const { job } = await api('/api/jobs', { url: text });
        setSelId(job.id); setView('job'); await refresh();
        return;
      }
      const { company, role } = parse(text);
      const result = await api('/api/positions', { company, role });
      setPicker(result); setView('picker');
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  const queue = async (positions, agentChooses) => {
    setBusy(true);
    try {
      const { added } = await api('/api/positions/queue', {
        company: picker.company,
        positions: positions.map((p) => ({ title: p.title, url: p.url, location: p.location })),
      });
      // Handing the choice over explicitly: start them all and let the agent
      // report which it judged a real fit.
      if (agentChooses) for (const j of added) await api('/api/jobs/start', { id: j.id });
      setPicker(null); setView('job'); setSelId(added[0]?.id ?? null);
      await refresh();
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  const act = async (path, body) => {
    setBusy(true);
    try { await api(path, body); await refresh(); }
    catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  const startable = jobs.filter((j) => (j.live?.status ?? 'found') === 'found');

  return (
    <div className={`app${jobs.length ? '' : ' solo'}`}>
      <aside className="rail">
        <div className="brand">
          <div>
            <h1>Dossier</h1>
            <p>applies the way each company asks</p>
          </div>
          <button className="brand-home" onClick={onHome}>Home</button>
        </div>

        <div className="add">
          <Composer onSubmit={compose} busy={busy} compact />
          {startable.length > 0 && (
            <button className="btn" style={{ marginTop: 10, width: '100%' }}
              disabled={busy}
              onClick={async () => {
                // One at a time. The server serialises queue writes anyway, but
                // firing these together also opened a burst of agent sessions
                // with nothing pacing them.
                for (const j of startable) await act('/api/jobs/start', { id: j.id });
              }}>
              Start all ({startable.length})
            </button>
          )}
        </div>

        <div className="jobs">
          {!jobs.length && <div style={{ padding: 20, color: 'var(--dim)', fontSize: 13 }}>
            Name a job to get started. No URL needed.
          </div>}
          {jobs.map((j) => {
            const st = j.live?.status ?? 'found';
            return (
              <div key={j.id} className={`job${j.id === selId ? ' sel' : ''}`}
                onClick={() => { setSelId(j.id); setView('job'); }}>
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

      <main className={`pane${view === 'compose' ? ' centred' : ''}`}>
        {view === 'picker' && picker ? (
          <PositionPicker result={picker} onQueue={queue} busy={busy}
            onBack={() => { setPicker(null); setView('compose'); }} />
        ) : view === 'job' && sel ? (
          <Detail job={sel} profile={profile} tab={tab} setTab={setTab}
            act={act} busy={busy} refresh={refresh} />
        ) : (
          <Composer onSubmit={compose} busy={busy} />
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

            {live.status === 'failed' && (
              <div className="note error">
                This run stopped before finishing. {live.turnError}
                <div className="sub">Nothing was submitted. Start it again to retry.</div>
              </div>
            )}

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
                <div className="warn">
                  {live.mode === 'live'
                    ? 'Submitting is irreversible — an application cannot be recalled.'
                    : 'Dry run: the real payload is captured locally, not sent to the employer.'}
                </div>

                {live.tailoring && (
                  <div className="tailor-summary">
                    <div><b>Leading with</b> {live.tailoring.ledWith.join(', ') || '—'}</div>
                    {live.tailoring.refused?.length > 0 && (
                      <div className="refused">
                        <b>Refused as unsupported</b> {live.tailoring.refused.join(', ')}
                      </div>
                    )}
                  </div>
                )}

                {live.resumeAvailable && (
                  <div className="resume-preview">
                    <div className="resume-preview-h">The résumé that will be attached</div>
                    <iframe title="résumé" src={`/api/jobs/resume?id=${job.id}&t=${live.turnId ?? ''}`} />
                    <a className="btn ghost" href={`/api/jobs/resume?id=${job.id}`}
                       target="_blank" rel="noreferrer">Open full size</a>
                  </div>
                )}
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
  const [upload, setUpload] = useState(null);
  const [uploading, setUploading] = useState(false);

  // An uploaded document only matters once it reaches the profile - that is what
  // tailoring reorders. So the text goes to the agent, which decides what
  // becomes a claim, and every edit it makes is versioned.
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true); setUpload(null); setResult('');
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/profile/upload', { method: 'POST', body: fd });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setUpload(d);
    } catch (err) { setResult(`Upload failed: ${err.message}`); }
    finally { setUploading(false); e.target.value = ''; }
  };

  const ingest = async () => {
    if (!upload) return;
    setRunning(true); setResult('');
    try {
      const { sessionId, turnId } = await api('/api/profile/prompt', {
        prompt:
          'Here is the text of my résumé. Turn it into my profile using update_profile: ' +
          'add my real skills, employers and accomplishments. Only record what the text ' +
          'actually says — do not embellish.\n\n' + upload.text,
      });
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await api(`/api/profile/status?session=${sessionId}&turn=${turnId}`);
        if (['done', 'failed', 'error'].includes(s.status)) { setResult(s.output || '(no output)'); break; }
      }
      setUpload(null);
      refresh();
    } catch (e) { setResult(`Error: ${e.message}`); }
    finally { setRunning(false); }
  };

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
        <h3>Upload a résumé or details</h3>
        <label className="upload">
          <input type="file" accept=".pdf,.txt,.md,.docx,.doc,.rtf" onChange={onFile} disabled={uploading} />
          <span>{uploading ? 'Reading…' : 'Choose a file'}</span>
        </label>
        <div className="warn" style={{ color: 'var(--fg-3)' }}>
          PDF, Word or plain text. Stored outside the repository, never committed.
        </div>
        {upload && (
          <div className="upload-result">
            <div><b>{upload.filename}</b> — {(upload.bytes / 1024).toFixed(0)} KB, read with {upload.extracted_with}</div>
            <div className="upload-skim">
              {upload.skim.likelyName && <span>{upload.skim.likelyName}</span>}
              {upload.skim.emails?.[0] && <span>{upload.skim.emails[0]}</span>}
              {upload.skim.sectionsFound?.length > 0 && <span>{upload.skim.sectionsFound.join(' · ')}</span>}
            </div>
            <button className="btn primary" onClick={ingest} disabled={running}>
              {running ? 'Adding to profile…' : 'Add this to my profile'}
            </button>
          </div>
        )}
      </div>

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
