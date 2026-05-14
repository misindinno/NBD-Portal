// ── Icons ─────────────────────────────────────────────────────────────

const ICONS = {
  mail: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2"/>
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
    </svg>
  ),
  key: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="5.5"/>
      <path d="m21 2-9.6 9.6"/>
      <path d="m15.5 7.5 3 3L22 7l-3-3"/>
    </svg>
  ),
  eye: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  ),
  eyeOff: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>
      <line x1="2" y1="2" x2="22" y2="22"/>
    </svg>
  ),
  google: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  ),
  github: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>
  ),
  loader: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ animation: 'ldr-spin .7s linear infinite', display: 'block' }}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
  ),
  check: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  warn: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  ),
  fingerprint: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4"/>
      <path d="M5 19.5C5.5 18 6 15 6 12c0-1.7.7-3.2 1.8-4.3"/>
      <path d="M17.5 12c0 2.3-.4 4.5-1.5 6.5"/>
      <path d="M12 12c0 3-1 5.5-3 7.5"/>
      <path d="M9 12a3 3 0 0 1 6 0c0 1.5-.2 2.9-.5 4.2"/>
      <path d="M12 7a5 5 0 0 1 5 5"/>
    </svg>
  )
};

// ── Reusable: field wrapper ────────────────────────────────────────────
function Field({ label, htmlFor, action, children, error }) {
  return (
    <div className="field">
      {(label || action) && (
        <div className="field-row">
          {label && (
            <label className="field-label" htmlFor={htmlFor}>{label}</label>
          )}
          {action && action}
        </div>
      )}
      {children}
      {error && <div className="field-err">{error}</div>}
    </div>
  );
}

// ── Reusable: submit button with loading / success / error states ──────
function SubmitBtn({ status, children, type, onClick }) {
  const loading = status === 'loading';
  const success = status === 'success';
  const isErr   = status === 'error';

  return (
    <button
      type={type || 'submit'}
      onClick={onClick}
      disabled={loading}
      className={'btn-auth' + (success ? ' success' : isErr ? ' err' : '')}
    >
      {loading && (
        <span style={{ width: 16, height: 16, display: 'flex', alignItems: 'center' }}>
          {ICONS.loader}
        </span>
      )}
      {success && (
        <span style={{ width: 16, height: 16, display: 'flex', alignItems: 'center' }}>
          {ICONS.check}
        </span>
      )}
      {loading ? 'Signing in…' : success ? 'Signed in!' : isErr ? 'Try again' : children}
    </button>
  );
}

// ── Email form ─────────────────────────────────────────────────────────
function EmailForm({ onSubmit, status }) {
  const [email,  setEmail]  = React.useState('');
  const [pw,     setPw]     = React.useState('');
  const [showPw, setShowPw] = React.useState(false);
  const [errors, setErrors] = React.useState({});

  const validate = () => {
    const e = {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      e.email = 'Enter a valid email address.';
    if (!pw || pw.length < 6)
      e.pw = 'Password must be at least 6 characters.';
    return e;
  };

  const handle = (evt) => {
    evt.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    onSubmit({ method: 'email', email, pw });
  };

  return (
    <form onSubmit={handle} noValidate>
      {status === 'error' && (
        <div className="status-msg err">
          <span style={{ width: 14, height: 14, display: 'flex', flexShrink: 0 }}>{ICONS.warn}</span>
          Incorrect email or password.
        </div>
      )}

      <Field label="Email" htmlFor="lf-email" error={errors.email}>
        <input
          id="lf-email"
          className={'input' + (errors.email ? ' err' : '')}
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          autoFocus={true}
          autoComplete="email"
        />
      </Field>

      <Field label="Password" htmlFor="lf-pw" error={errors.pw}>
        <div className="input-wrap">
          <input
            id="lf-pw"
            className={'input has-icon' + (errors.pw ? ' err' : '')}
            type={showPw ? 'text' : 'password'}
            placeholder="••••••••"
            value={pw}
            onChange={e => setPw(e.target.value)}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="input-icon"
            onClick={() => setShowPw(s => !s)}
            tabIndex={-1}
            aria-label={showPw ? 'Hide password' : 'Show password'}
          >
            {showPw ? ICONS.eyeOff : ICONS.eye}
          </button>
        </div>
      </Field>

      <SubmitBtn status={status}>Sign in</SubmitBtn>
    </form>
  );
}

