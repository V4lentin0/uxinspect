export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export function ErrorBlock({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="callout callout-red" role="alert">
      <div>
        <p className="callout-title">Something went wrong</p>
        <p className="callout-body">{msg}</p>
      </div>
    </div>
  );
}
