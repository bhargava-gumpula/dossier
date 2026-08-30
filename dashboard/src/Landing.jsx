import { useEffect, useRef } from 'react';

// Apple's front-page grammar: a short declarative headline, one thin subhead,
// a single blue call to action, then chapters separated by large silence.

function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const els = ref.current?.querySelectorAll('.reveal') ?? [];
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('in')),
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return ref;
}

export default function Landing({ onEnter }) {
  const ref = useReveal();

  return (
    <div className="landing" ref={ref}>
      <nav className="nav">
        <div className="nav-inner">
          <span className="nav-brand">Dossier</span>
          <div className="nav-links">
            <a href="#how">How it works</a>
            <a href="#gate">The gate</a>
            <a href="#walls">Limits</a>
            <button className="nav-cta" onClick={onEnter}>Open dashboard</button>
          </div>
        </div>
      </nav>

      {/* ---------------------------------------------------------------- hero */}
      <section className="hero">
        <div className="wrap">
          <p className="t-eyebrow reveal">Dossier</p>
          <h1 className="t-hero reveal">Applies the way<br />each company asks.</h1>
          <p className="t-sub reveal hero-sub">
            Name a job. It works out how that employer actually accepts applications,
            fills the real form, and stops one click short.
          </p>
          <div className="hero-cta reveal">
            <button className="btn-pill" onClick={onEnter}>Open dashboard</button>
            <a className="btn-pill ghost" href="#how">See how it works</a>
          </div>
        </div>

        <div className="hero-art reveal">
          <div className="chrome">
            <div className="chrome-bar"><i /><i /><i /></div>
            <div className="chrome-body">
              <div className="mock-rail">
                <div className="mock-row on">
                  <span>Backend Engineer, Payments</span>
                  <em className="tag violet">awaiting you</em>
                </div>
                <div className="mock-row">
                  <span>Senior Backend Engineer</span>
                  <em className="tag amber">needs you</em>
                </div>
                <div className="mock-row">
                  <span>Platform Engineer</span>
                  <em className="tag green">submitted</em>
                </div>
              </div>
              <div className="mock-pane">
                <div className="mock-gate">
                  <p className="mock-gate-h">Held for your approval</p>
                  <p className="mock-gate-b">
                    The agent has filled this application and is waiting to submit it.
                    <strong> Nothing has been sent.</strong>
                  </p>
                  <div className="mock-actions">
                    <span className="mock-btn blue">Approve &amp; submit</span>
                    <span className="mock-btn">Send back</span>
                  </div>
                </div>
                <div className="mock-steps">
                  {['detect_apply_route', 'inspect_form — 26 fields', 'sandbox: matched résumé to the role', 'fill_form — résumé attached'].map((s) => (
                    <div key={s} className="mock-step"><i />{s}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- chapter */}
      <section className="band" id="how">
        <div className="wrap">
          <h2 className="t-section reveal">Every company applies<br />differently. It figures out how.</h2>
          <p className="t-body reveal band-sub">
            Greenhouse, Ashby, Workday, a homemade form, an email address. Where a job
            was found tells you nothing about how that employer wants to receive an
            application, so every posting is fingerprinted on its own.
          </p>

          <div className="routes reveal">
            {[
              ['Greenhouse', 'Publishes the real form — 19 fields, required flags, dropdown options.'],
              ['Ashby', 'Listings and descriptions, read live from the public board.'],
              ['Workday', 'Two thousand open roles at a single employer, paged through.'],
              ['Bespoke', 'A real browser reads the form that JavaScript builds.'],
            ].map(([k, v]) => (
              <div className="route" key={k}>
                <h3>{k}</h3>
                <p>{v}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ gate */}
      <section className="band dark" id="gate">
        <div className="wrap">
          <p className="t-eyebrow reveal" style={{ color: 'var(--violet)' }}>The gate</p>
          <h2 className="t-section reveal">It stops one click short.</h2>
          <p className="t-body reveal band-sub">
            The agent fills every field and attaches your résumé, then freezes. Not a
            confirmation dialog — the harness is genuinely holding the call. Close the
            tab, come back tomorrow, and it is still waiting for you.
          </p>
          <div className="stat-row reveal">
            <div><b>0</b><span>applications sent without you</span></div>
            <div><b>1</b><span>irreversible action, gated</span></div>
            <div><b>∞</b><span>time to change your mind</span></div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------------- walls */}
      <section className="band" id="walls">
        <div className="wrap">
          <h2 className="t-section reveal">It tells you what it cannot do.</h2>
          <p className="t-body reveal band-sub">
            Every major applicant system gates submission behind an employer credential
            or a CAPTCHA. We checked six. So where the agent cannot legitimately finish,
            it says which wall it hit and hands you a completed form — rather than
            claiming it applied when it did not.
          </p>
          <div className="walls reveal">
            {[
              ['CAPTCHA', 'Not solved. Never worked around.'],
              ['Account required', 'Some employers demand an account first.'],
              ['Bot protection', 'Some sites refuse a browser outright.'],
            ].map(([k, v]) => (
              <div className="wall" key={k}><h3>{k}</h3><p>{v}</p></div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- résumé */}
      <section className="band alt">
        <div className="wrap">
          <h2 className="t-section reveal">Your résumé, edited by asking.</h2>
          <p className="t-body reveal band-sub">
            “Add Terraform to my skills.” “Add a bullet at Meridian about cutting cloud
            spend.” The PDF rebuilds itself, and every version is kept. It will not add
            a skill on its own to improve a match — that is your claim to make.
          </p>
          <div className="prompt-demo reveal">
            <span className="prompt-caret">›</span>
            add a bullet at Meridian about cutting cloud spend 28%
          </div>
        </div>
      </section>

      <section className="closer">
        <div className="wrap">
          <h2 className="t-section reveal">Name a job.</h2>
          <div className="hero-cta reveal" style={{ justifyContent: 'center' }}>
            <button className="btn-pill" onClick={onEnter}>Open dashboard</button>
          </div>
        </div>
      </section>

      <footer className="foot">
        <div className="wrap">
          <p className="t-caption">
            Dossier submits only what you approve. Built on TrueForge for the Agent
            Harness Hackathon. Demo data is a synthetic persona.
          </p>
        </div>
      </footer>
    </div>
  );
}
