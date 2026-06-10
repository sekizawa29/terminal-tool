// Uppercase section heading inside the sessions/recent dropdown.
export function SectionLabel({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: '6px 10px 4px',
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--text-ghost)',
      }}
    >
      {text}
    </div>
  );
}
