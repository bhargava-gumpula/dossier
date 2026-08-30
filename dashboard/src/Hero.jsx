import './hero.css';

// The 21st.dev hero, ported to this project's stack.
//
// The published component is TSX on Tailwind + shadcn, importing shadcn's Button
// (Radix Slot + class-variance-authority) and a lucide-react chevron. None of
// that is here, and installing it was the wrong trade: Tailwind's preflight is a
// global reset, so it would have restyled the dashboard - which was explicitly
// meant to stay exactly as it is. The markup and the design are the same; the
// classes resolve through hero.css instead, the chevron is inlined, and one link
// styled as a button does not need a variant system behind it.
//
// `background` is a slot so another layer - the ASCII forest, say - can sit
// under the grid without this component knowing anything about it.
export default function Hero({
  eyebrow = 'Innovate Without Limits',
  eyebrowHref = '#',
  title,
  subtitle,
  ctaLabel = 'Explore Now',
  ctaHref = '#',
  onCta,
  secondaryLabel,
  secondaryHref = '#',
  background = null,
}) {
  return (
    <section id="hero" className="hx-hero">
      {background}
      <div className="hx-grid" aria-hidden="true" />
      <div className="hx-accent" aria-hidden="true" />

      <div className="hx-content">
        {eyebrow && (
          <a href={eyebrowHref} className="hx-eyebrow-link group">
            <span className="hx-eyebrow">
              {eyebrow}
              {/* lucide-react's ChevronRight, inlined rather than pulled in as a
                  dependency for a single glyph. */}
              <svg
                className="hx-chevron"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
          </a>
        )}

        <h1 className="hx-title">{title}</h1>
        <p className="hx-sub">{subtitle}</p>

        {ctaLabel && (
          <div className="hx-cta-row">
            {onCta ? (
              <button type="button" className="hx-btn hx-btn-primary" onClick={onCta}>
                {ctaLabel}
              </button>
            ) : (
              <a className="hx-btn hx-btn-primary" href={ctaHref}>{ctaLabel}</a>
            )}
            {secondaryLabel && (
              <a className="hx-btn hx-btn-ghost" href={secondaryHref}>{secondaryLabel}</a>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
