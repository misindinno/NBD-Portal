// ── Login left panel: product feature highlights ────────────────────────

const FEATURES = [
  {
    title: "Lead Management",
    desc:  "Capture, assign and track every prospect from first contact to close",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="rgba(255,255,255,0.82)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <polyline points="16 11 18 13 22 9"/>
      </svg>
    )
  },
  {
    title: "Sales Pipeline",
    desc:  "Visualise your funnel stage by stage and move deals forward in real time",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="rgba(255,255,255,0.82)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10"/>
        <line x1="12" y1="20" x2="12" y2="4"/>
        <line x1="6" y1="20" x2="6" y2="14"/>
      </svg>
    )
  },
  {
    title: "Smart Follow-ups",
    desc:  "Scheduled reminders so no opportunity ever slips through the cracks",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="rgba(255,255,255,0.82)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
    )
  },
  {
    title: "Team & Roles",
    desc:  "Assign leads, set permissions and monitor your whole team's activity",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="rgba(255,255,255,0.82)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    )
  }
];

function LoginSide() {
  return (
    <aside className="login-side">
      <div className="grid-bg" />

      {/* Top bar */}
      <div className="ls-top">
        <div className="brand">
          <span className="mark" />
          NBD Portal
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "8px 0" }}>
        <p style={{ fontSize: 23, fontWeight: 700, color: "#fff", lineHeight: 1.25, margin: "0 0 4px" }}>
          Your entire sales operation.
        </p>
        <p style={{ fontSize: 23, fontWeight: 700, color: "rgba(255,255,255,0.3)", lineHeight: 1.25, margin: "0 0 36px" }}>
          One simple portal.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {FEATURES.map(f => (
            <div key={f.title} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{
                width: 40, height: 40,
                background: "rgba(255,255,255,0.10)",
                borderRadius: 10,
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0
              }}>
                {f.icon}
              </div>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "rgba(255,255,255,0.9)", marginBottom: 3 }}>
                  {f.title}
                </div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.42)", lineHeight: 1.55 }}>
                  {f.desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Stats footer */}
      <div className="ls-stats">
        <div>
          <div className="ls-stat-k">Leads</div>
          <div className="ls-stat-v">50k<span className="ls-stat-u">+</span></div>
        </div>
        <div>
          <div className="ls-stat-k">Uptime</div>
          <div className="ls-stat-v"><span className="ls-live" />99.9<span className="ls-stat-u">%</span></div>
        </div>
        <div>
          <div className="ls-stat-k">Follow-ups</div>
          <div className="ls-stat-v">200k<span className="ls-stat-u">+</span></div>
        </div>
      </div>
    </aside>
  );
}
