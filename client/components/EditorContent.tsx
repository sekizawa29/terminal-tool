import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';

interface EditorContentProps {
  filePath: string;
  isActive: boolean;
}

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

const LANGUAGE_NAMES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript React',
  js: 'JavaScript',
  jsx: 'JavaScript React',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  h: 'C Header',
  cs: 'C#',
  rb: 'Ruby',
  php: 'PHP',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  xml: 'XML',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  md: 'Markdown',
  mdx: 'MDX',
  sql: 'SQL',
  graphql: 'GraphQL',
  dockerfile: 'Dockerfile',
  txt: 'Plain Text',
  env: 'Environment',
  svg: 'SVG',
};

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

async function readApiPayload(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await res.json();
  }
  return await res.text();
}

function getApiError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }
  if (typeof payload === 'string' && payload.trim()) {
    return payload.slice(0, 200);
  }
  return fallback;
}

export default function EditorContent({ filePath, isActive }: EditorContentProps) {
  const [content, setContent] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [extension, setExtension] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<string | null>(null);
  const savedContentRef = useRef<string | null>(null);

  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const isImageFile = IMAGE_EXTENSIONS.has(ext);

  useEffect(() => {
    contentRef.current = content;
    savedContentRef.current = savedContent;
  }, [content, savedContent]);

  const loadFile = useCallback(async (force = false) => {
    if (
      !force &&
      savedContentRef.current !== null &&
      contentRef.current !== null &&
      contentRef.current !== savedContentRef.current
    ) {
      const confirmed = window.confirm('Discard unsaved changes and reload this file?');
      if (!confirmed) return;
    }

    setLoading(true);
    setError(null);
    try {
      if (isImageFile) {
        setContent('');
        setSavedContent('');
        setExtension(ext);
        setFileName(filePath.split('/').pop() || '');
        setFileSize(0);
      } else {
        const res = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
        const data = await readApiPayload(res);
        if (!res.ok) {
          throw new Error(getApiError(data, 'Failed to load file'));
        }
        if (!data || typeof data !== 'object') {
          throw new Error('Invalid file response');
        }
        setContent(data.content);
        setSavedContent(data.content);
        setExtension(data.extension);
        setFileName(data.name);
        setFileSize(data.size);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [ext, filePath, isImageFile]);

  useEffect(() => {
    loadFile(true);
  }, [loadFile]);

  const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);
  const isImage = IMAGE_EXTENSIONS.has(extension);
  const languageName = LANGUAGE_NAMES[extension] || extension.toUpperCase() || 'File';
  const editable = !isImage && (!isMarkdown || viewMode === 'source');
  const dirty = content !== null && savedContent !== null && content !== savedContent;
  const lineCount = useMemo(() => (content ? content.split('\n').length : 0), [content]);

  const saveFile = useCallback(async () => {
    if (!editable || content === null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content }),
      });
      const data = await readApiPayload(res);
      if (!res.ok) {
        throw new Error(getApiError(data, `Failed to save file (HTTP ${res.status})`));
      }
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid save response');
      }
      setSavedContent(content);
      setFileSize(data.size ?? fileSize);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [content, editable, filePath, fileSize]);

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveFile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, saveFile]);

  useEffect(() => {
    if (isActive && editable) {
      textareaRef.current?.focus();
    }
  }, [editable, isActive, filePath]);

  const handleScroll = useCallback(() => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  const renderedHtml = isMarkdown && content && viewMode === 'rendered'
    ? marked(content) as string
    : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: '#16161e',
        color: 'var(--text-secondary)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          borderBottom: '1px solid rgba(0, 0, 0, 0.3)',
          background: 'rgba(22, 22, 30, 0.95)',
          flexShrink: 0,
          minHeight: 30,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {languageName}
        </span>
        {dirty && (
          <span
            style={{
              fontSize: 10,
              color: 'var(--accent-yellow)',
              fontWeight: 600,
            }}
          >
            Unsaved
          </span>
        )}
        <div style={{ flex: 1 }} />
        {isMarkdown && (
          <div style={{ display: 'flex', gap: 2 }}>
            <button
              onClick={() => setViewMode('rendered')}
              style={{
                fontSize: 10,
                padding: '2px 8px',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                background: viewMode === 'rendered' ? 'rgba(122, 162, 247, 0.2)' : 'none',
                color: viewMode === 'rendered' ? 'var(--accent-blue)' : 'var(--text-tertiary)',
                fontWeight: 500,
              }}
            >
              Preview
            </button>
            <button
              onClick={() => setViewMode('source')}
              style={{
                fontSize: 10,
                padding: '2px 8px',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                background: viewMode === 'source' ? 'rgba(122, 162, 247, 0.2)' : 'none',
                color: viewMode === 'source' ? 'var(--accent-blue)' : 'var(--text-tertiary)',
                fontWeight: 500,
              }}
            >
              Source
            </button>
          </div>
        )}
        <button
          onClick={saveFile}
          disabled={!editable || !dirty || saving}
          title="Save (Ctrl/Cmd+S)"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 46,
            height: 22,
            padding: '0 8px',
            background: !editable || !dirty || saving ? 'rgba(255,255,255,0.04)' : 'rgba(122, 162, 247, 0.2)',
            border: 'none',
            color: !editable || !dirty || saving ? 'var(--text-ghost)' : 'var(--accent-blue)',
            cursor: !editable || !dirty || saving ? 'default' : 'pointer',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {saving ? 'Saving' : 'Save'}
        </button>
        <button
          onClick={() => loadFile(false)}
          title="Reload"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            background: 'none',
            border: 'none',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            borderRadius: 4,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'none';
          }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path
              d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v4h-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {loading && (
          <div
            style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--text-ghost)',
              fontSize: 11,
            }}
          >
            Loading...
          </div>
        )}
        {error && (
          <div
            style={{
              padding: '10px 16px',
              color: 'var(--accent-red)',
              fontSize: 12,
              borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
              background: 'rgba(247, 118, 142, 0.08)',
            }}
          >
            {error}
          </div>
        )}
        {!loading && !error && content !== null && (
          <>
            {isImage ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 20,
                  height: '100%',
                }}
              >
                <img
                  src={`/api/files/read?path=${encodeURIComponent(filePath)}&mode=raw`}
                  alt={fileName}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    borderRadius: 4,
                  }}
                />
              </div>
            ) : renderedHtml ? (
              <div
                className="markdown-body"
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
                style={{
                  padding: '16px 20px',
                  lineHeight: 1.7,
                  fontSize: 13,
                  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                  color: '#c0caf5',
                  overflowWrap: 'break-word',
                }}
              />
            ) : (
              <div style={{ display: 'flex', height: '100%' }}>
                <div
                  ref={lineNumbersRef}
                  style={{
                    padding: '8px 0',
                    textAlign: 'right',
                    userSelect: 'none',
                    flexShrink: 0,
                    overflow: 'hidden',
                    borderRight: '1px solid rgba(255, 255, 255, 0.04)',
                    background: 'rgba(0, 0, 0, 0.1)',
                  }}
                >
                  {content.split('\n').map((_, i) => (
                    <div
                      key={i}
                      style={{
                        padding: '0 12px',
                        fontSize: 12,
                        lineHeight: '20px',
                        color: 'var(--text-ghost)',
                        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {i + 1}
                    </div>
                  ))}
                </div>
                <textarea
                  ref={textareaRef}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  onScroll={handleScroll}
                  spellCheck={false}
                  readOnly={!editable}
                  style={{
                    margin: 0,
                    padding: '8px 16px',
                    flex: 1,
                    resize: 'none',
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    fontSize: 12,
                    lineHeight: '20px',
                    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
                    color: '#c0caf5',
                    tabSize: 2,
                    whiteSpace: 'pre',
                    overflow: 'auto',
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '2px 10px',
          borderTop: '1px solid rgba(0, 0, 0, 0.3)',
          background: 'rgba(22, 22, 30, 0.95)',
          flexShrink: 0,
          height: 22,
          fontSize: 10,
          color: 'var(--text-ghost)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span>{lineCount} lines</span>
        <span>
          {fileSize < 1024
            ? `${fileSize}B`
            : fileSize < 1024 * 1024
            ? `${(fileSize / 1024).toFixed(1)}KB`
            : `${(fileSize / (1024 * 1024)).toFixed(1)}MB`}
        </span>
        <span>{editable ? 'Editable' : 'Read only'}</span>
        <span style={{ flex: 1 }} />
        <span style={{ direction: 'rtl', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <bdi>{filePath}</bdi>
        </span>
      </div>
    </div>
  );
}
