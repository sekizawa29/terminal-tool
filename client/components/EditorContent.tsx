import { useCallback, useEffect, useState } from 'react';
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

export default function EditorContent({ filePath, isActive }: EditorContentProps) {
  const [content, setContent] = useState<string | null>(null);
  const [extension, setExtension] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');

  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const isImageFile = IMAGE_EXTENSIONS.has(ext);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isImageFile) {
        // For images, just set metadata — the img tag loads via /api/files/raw
        setContent('');
        setExtension(ext);
        setFileName(filePath.split('/').pop() || '');
        setFileSize(0);
      } else {
        const res = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to load file');
        }
        const data = await res.json();
        setContent(data.content);
        setExtension(data.extension);
        setFileName(data.name);
        setFileSize(data.size);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [filePath, isImageFile, ext]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);
  const isImage = IMAGE_EXTENSIONS.has(extension);
  const languageName = LANGUAGE_NAMES[extension] || extension.toUpperCase() || 'File';
  const lineCount = content ? content.split('\n').length : 0;

  // Render markdown to HTML
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
      {/* Header bar */}
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
          onClick={loadFile}
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

      {/* Content area */}
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
              padding: 16,
              color: 'var(--accent-red)',
              fontSize: 12,
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
                {/* Line numbers */}
                <div
                  style={{
                    padding: '8px 0',
                    textAlign: 'right',
                    userSelect: 'none',
                    flexShrink: 0,
                    borderRight: '1px solid rgba(255, 255, 255, 0.04)',
                    background: 'rgba(0, 0, 0, 0.1)',
                  }}
                >
                  {content.split('\n').map((_, i) => (
                    <div
                      key={i}
                      style={{
                        padding: '0 12px 0 12px',
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
                {/* Code content */}
                <pre
                  style={{
                    margin: 0,
                    padding: '8px 16px',
                    flex: 1,
                    overflow: 'auto',
                    fontSize: 12,
                    lineHeight: '20px',
                    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
                    color: '#c0caf5',
                    tabSize: 2,
                  }}
                >
                  {content}
                </pre>
              </div>
            )}
          </>
        )}
      </div>

      {/* Status bar */}
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
        <span style={{ flex: 1 }} />
        <span style={{ direction: 'rtl', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <bdi>{filePath}</bdi>
        </span>
      </div>
    </div>
  );
}
