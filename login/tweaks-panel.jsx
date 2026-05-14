// ── Tweaks panel: live theme / accent switcher ────────────────────────

function useTweaks(defaults) {
  const KEY = 'halcyon-tweaks';
  const init = () => {
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    } catch (_) {
      return { ...defaults };
    }
  };
  const [tweaks, setTweaks] = React.useState(init);

  const setTweak = (k, v) => {
    const next = { ...tweaks, [k]: v };
    setTweaks(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (_) {}
  };

  return [tweaks, setTweak];
}

function TweaksPanel({ children }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10
    }}>
      {open && (
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--line-2)',
          borderRadius: 14,
          padding: '18px 20px 14px',
          minWidth: 230,
          boxShadow: '0 8px 40px rgba(11,11,15,0.14), 0 2px 8px rgba(11,11,15,0.06)',
          animation: 'f-in .2s cubic-bezier(.2,.7,.2,1)'
        }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '.09em',
            textTransform: 'uppercase', color: 'var(--muted)',
            marginBottom: 14, fontFamily: 'var(--mono)'
          }}>Appearance</div>
          {children}
        </div>
      )}
      <button
        onClick={() => setOpen(o => !o)}
        title="Appearance"
        style={{
          width: 40, height: 40,
          borderRadius: 10,
          background: open ? 'var(--accent)' : 'var(--surface)',
          border: '1px solid var(--line-2)',
          color: open ? '#fff' : 'var(--muted)',
          cursor: 'pointer',
          display: 'grid', placeItems: 'center',
          boxShadow: '0 2px 8px rgba(11,11,15,0.10)',
          transition: 'all 0.15s',
          outline: 'none'
        }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
    </div>
  );
}

function TweakSection({ label }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '.07em',
      textTransform: 'uppercase', color: 'var(--muted)',
      marginTop: 14, marginBottom: 8,
      paddingBottom: 6, borderBottom: '1px solid var(--line)',
      fontFamily: 'var(--mono)'
    }}>
      {label}
    </div>
  );
}

function TweakRadio({ label, value, options, onChange }) {
  return (
    <div style={{ marginBottom: 12 }}>
      {label && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 7 }}>{label}</div>
      )}
      <div style={{ display: 'flex', gap: 4 }}>
        {options.map(o => (
          <button
            key={o}
            onClick={() => onChange(o)}
            style={{
              flex: 1,
              height: 30,
              fontSize: 12,
              fontWeight: 500,
              borderRadius: 6,
              border: '1px solid',
              borderColor: value === o ? 'var(--accent)' : 'var(--line-2)',
              background: value === o ? 'var(--accent-soft)' : 'var(--surface-2)',
              color: value === o ? 'var(--accent)' : 'var(--ink-2)',
              cursor: 'pointer',
              transition: 'all 0.15s',
              fontFamily: 'var(--sans)',
              outline: 'none'
            }}
          >
            {o.charAt(0).toUpperCase() + o.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

function TweakColor({ label, value, options, onChange }) {
  return (
    <div style={{ marginBottom: 6 }}>
      {label && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10 }}>{label}</div>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {options.map(c => (
          <button
            key={c}
            onClick={() => onChange(c)}
            title={c}
            style={{
              width: 22, height: 22,
              borderRadius: '50%',
              background: c,
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              outline: value === c ? `2px solid ${c}` : '2px solid transparent',
              outlineOffset: 2,
              transition: 'all 0.15s'
            }}
          />
        ))}
      </div>
    </div>
  );
}
