import { useCallback, useRef, useState } from 'react';

function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0';
  } catch {
    return false;
  }
}

interface BrowserContentProps {
  url: string;
  isActive: boolean;
  onUrlChange: (url: string) => void;
}

export default function BrowserContent({ url, isActive, onUrlChange }: BrowserContentProps) {
  const [inputUrl, setInputUrl] = useState(url);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const historyRef = useRef<string[]>([url]);
  const historyIndexRef = useRef(0);

  const navigate = useCallback((newUrl: string, addToHistory = true) => {
    let normalized = newUrl.trim();
    if (!normalized) return;
    if (!/^https?:\/\//i.test(normalized)) {
      if (/^localhost(:\d+)?/.test(normalized) || /^127\.0\.0\.1(:\d+)?/.test(normalized)) {
        normalized = 'http://' + normalized;
      } else if (normalized.includes('.') && !normalized.includes(' ')) {
        normalized = 'https://' + normalized;
      } else {
        normalized = 'https://www.google.com/search?igu=1&q=' + encodeURIComponent(normalized);
      }
    }
    setCurrentUrl(normalized);
    setInputUrl(normalized);
    setLoading(true);
    onUrlChange(normalized);

    if (addToHistory) {
      const history = historyRef.current;
      const idx = historyIndexRef.current;
      historyRef.current = [...history.slice(0, idx + 1), normalized];
      historyIndexRef.current = historyRef.current.length - 1;
    }
    setCanGoBack(historyIndexRef.current > 0);
    setCanGoForward(historyIndexRef.current < historyRef.current.length - 1);
  }, [onUrlChange]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    navigate(inputUrl);
  }, [inputUrl, navigate]);

  const goBack = useCallback(() => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      navigate(historyRef.current[historyIndexRef.current], false);
    }
  }, [navigate]);

  const goForward = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++;
      navigate(historyRef.current[historyIndexRef.current], false);
    }
  }, [navigate]);

  const reload = useCallback(() => {
    if (iframeRef.current) {
      setLoading(true);
      iframeRef.current.src = currentUrl;
    }
  }, [currentUrl]);

  const navBtn: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    background: 'none',
    border: 'none',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    borderRadius: 5,
    flexShrink: 0,
    transition: 'background 120ms, color 120ms',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#1a1b26' }}>
      {/* URL bar */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 6px',
          borderBottom: '1px solid rgba(0, 0, 0, 0.3)',
          background: 'rgba(22, 22, 30, 0.95)',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={goBack}
          disabled={!canGoBack}
          style={{ ...navBtn, opacity: canGoBack ? 1 : 0.3 }}
          title="Back"
          onMouseEnter={(e) => { if (canGoBack) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button
          type="button"
          onClick={goForward}
          disabled={!canGoForward}
          style={{ ...navBtn, opacity: canGoForward ? 1 : 0.3 }}
          title="Forward"
          onMouseEnter={(e) => { if (canGoForward) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button
          type="button"
          onClick={reload}
          style={navBtn}
          title="Reload"
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder="URL or search..."
          style={{
            flex: 1,
            height: 26,
            padding: '0 8px',
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            borderRadius: 6,
            color: 'var(--text-secondary)',
            fontSize: 11.5,
            fontFamily: 'inherit',
            outline: 'none',
            transition: 'border-color 120ms, background 120ms',
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </form>

      {/* Loading bar */}
      {loading && (
        <div style={{
          height: 2,
          background: 'var(--accent-blue)',
          animation: 'browserLoadBar 1.5s ease-in-out infinite',
          flexShrink: 0,
        }} />
      )}

      {/* iframe — no sandbox for localhost to allow full dev tool access */}
      <iframe
        ref={iframeRef}
        src={currentUrl}
        onLoad={() => setLoading(false)}
        {...(isLocalUrl(currentUrl) ? {} : { sandbox: 'allow-same-origin allow-scripts allow-popups allow-forms allow-modals' })}
        style={{
          flex: 1,
          width: '100%',
          border: 'none',
          background: '#fff',
        }}
        title="Browser"
      />
    </div>
  );
}
