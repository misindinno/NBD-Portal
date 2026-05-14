// ── Config ───────────────────────────────────────────────────────────
// Fill these in before deploying the standalone login page.
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID_HERE'; // ← OAuth 2.0 Client ID from Google Cloud Console
const GAS_APP_URL      = 'YOUR_GAS_DEPLOYMENT_URL_HERE'; // ← Your GAS web app deployment URL

// ── App shell: theme system + form pane ──────────────────────────────

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme":  "light",
  "accent": "indigo"
} /*EDITMODE-END*/;

const THEMES_SAAS = {
  light: {
    label: "Light",
    bg:       "#FAFAFA",
    surface:  "#FFFFFF",
    surface2: "#F4F4F5",
    surface3: "#EAEAEC",
    ink:      "#0B0B0F",
    ink2:     "#2C2D33",
    muted:    "#6B6E76",
    muted2:   "#9A9DA4",
    line:     "rgba(11,11,15,0.08)",
    line2:    "rgba(11,11,15,0.14)",
    grid:     "rgba(11,11,15,0.04)"
  },
  dim: {
    label: "Dim",
    bg:       "#F2F1EE",
    surface:  "#FAF9F6",
    surface2: "#EDECE6",
    surface3: "#E2E0D9",
    ink:      "#1B1A18",
    ink2:     "#3B3934",
    muted:    "#7A766C",
    muted2:   "#A6A299",
    line:     "rgba(27,26,24,0.08)",
    line2:    "rgba(27,26,24,0.16)",
    grid:     "rgba(27,26,24,0.04)"
  },
  dark: {
    label: "Dark",
    bg:       "#0B0B0F",
    surface:  "#15151A",
    surface2: "#1B1B22",
    surface3: "#242530",
    ink:      "#F4F4F6",
    ink2:     "#C8C9CF",
    muted:    "#8A8C95",
    muted2:   "#5A5C66",
    line:     "rgba(255,255,255,0.07)",
    line2:    "rgba(255,255,255,0.13)",
    grid:     "rgba(255,255,255,0.04)"
  }
};

const ACCENTS = {
  indigo:  { label: "Indigo",  base: "#4F46E5", alt: "#7C3AED", soft: "rgba(79,70,229,0.10)"  },
  emerald: { label: "Emerald", base: "#059669", alt: "#10B981", soft: "rgba(5,150,105,0.10)"   },
  amber:   { label: "Amber",   base: "#D97706", alt: "#F59E0B", soft: "rgba(217,119,6,0.10)"   },
  rose:    { label: "Rose",    base: "#E11D48", alt: "#F43F5E", soft: "rgba(225,29,72,0.10)"   }
};

function applyThemeSaas(themeKey, accentKey) {
  const t = THEMES_SAAS[themeKey] || THEMES_SAAS.light;
  const a = ACCENTS[accentKey]   || ACCENTS.indigo;
  const r = document.documentElement;

  r.style.setProperty("--bg",          t.bg);
  r.style.setProperty("--surface",     t.surface);
  r.style.setProperty("--surface-2",   t.surface2);
  r.style.setProperty("--surface-3",   t.surface3);
  r.style.setProperty("--ink",         t.ink);
  r.style.setProperty("--ink-2",       t.ink2);
  r.style.setProperty("--muted",       t.muted);
  r.style.setProperty("--muted-2",     t.muted2);
  r.style.setProperty("--line",        t.line);
  r.style.setProperty("--line-2",      t.line2);
  r.style.setProperty("--accent",      a.base);
  r.style.setProperty("--accent-2",    a.alt);
  r.style.setProperty("--accent-soft", a.soft);
  r.style.setProperty("color-scheme",  themeKey === "dark" ? "dark" : "light");

  const grid = document.querySelector(".grid-bg");
  if (grid) {
    grid.style.backgroundImage =
      "linear-gradient(to right, " + t.grid + " 1px, transparent 1px)," +
      "linear-gradient(to bottom, " + t.grid + " 1px, transparent 1px)";
  }
}

// ── Form pane (right half) ────────────────────────────────────────────
function FormPane() {
  const btnRef   = React.useRef(null);
  const [status, setStatus] = React.useState("loading"); // loading | ready | unconfigured | timeout

  const configured = GOOGLE_CLIENT_ID !== "YOUR_GOOGLE_CLIENT_ID_HERE" &&
                     GAS_APP_URL      !== "YOUR_GAS_DEPLOYMENT_URL_HERE";

  React.useEffect(() => {
    if (!configured) { setStatus("unconfigured"); return; }
    let tries = 0;
    const iv = setInterval(() => {
      if (window.google && window.google.accounts) {
        clearInterval(iv);
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: function(resp) {
            window.location.href = GAS_APP_URL + "?google_token=" + encodeURIComponent(resp.credential);
          }
        });
        setStatus("ready");
      }
      if (++tries > 60) { clearInterval(iv); setStatus("timeout"); }
    }, 100);
    return () => clearInterval(iv);
  }, []);

  React.useEffect(() => {
    if (status === "ready" && btnRef.current) {
      window.google.accounts.id.renderButton(btnRef.current, {
        theme: "outline",
        size: "large",
        text: "signin_with",
        shape: "rectangular",
        width: 320
      });
    }
  }, [status]);

  return (
    <section className="form-pane">
      {/* Top bar */}
      <div className="form-top">
        <div className="brand">
          <span className="mark" />
          NBD Portal
        </div>
      </div>

      {/* Form card */}
      <div className="form-wrap">
        <div className="form anim">
          <h1 className="title">Welcome back</h1>
          <p className="subtitle">Sign in to your NBD Portal workspace.</p>

          {status === "unconfigured" && (
            <div className="status-msg err" style={{ marginTop: 20, fontSize: 12 }}>
              {ICONS.warn}
              <span>Configure GOOGLE_CLIENT_ID and GAS_APP_URL in login-app.jsx.</span>
            </div>
          )}

          <div style={{ marginTop: 24, display: "flex", justifyContent: "center", minHeight: 48 }}>
            {status === "ready"
              ? <div ref={btnRef}></div>
              : status === "loading"
                ? <button type="button" className="btn-auth" disabled style={{ opacity: 0.5 }}>
                    <span style={{ width: 16, height: 16, display: "flex", alignItems: "center" }}>{ICONS.loader}</span>
                    Loading…
                  </button>
                : status === "timeout"
                  ? <button type="button" className="btn-auth" disabled style={{ opacity: 0.5 }}>
                      {ICONS.google}&nbsp; Google unavailable
                    </button>
                  : null
            }
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="form-bot">
        <span className="left">
          <span className="dot" />
          All systems operational
        </span>
      </div>
    </section>
  );
}

// ── Root app ─────────────────────────────────────────────────────────
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  React.useEffect(() => { applyThemeSaas(t.theme, t.accent); }, [t.theme, t.accent]);

  return (
    <>
      <div className="stage">
        <LoginSide />
        <FormPane />
      </div>

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio
          label="Mode"
          value={t.theme}
          options={["light", "dim", "dark"]}
          onChange={v => setTweak("theme", v)}
        />
        <TweakSection label="Accent" />
        <TweakColor
          label="Color"
          value={ACCENTS[t.accent] ? ACCENTS[t.accent].base : "#4F46E5"}
          options={Object.values(ACCENTS).map(a => a.base)}
          onChange={v => {
            const k = Object.keys(ACCENTS).find(k => ACCENTS[k].base === v) || "indigo";
            setTweak("accent", k);
          }}
        />
      </TweaksPanel>
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
