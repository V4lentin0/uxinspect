import type { ReactNode } from 'react';

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty" role="status">
      <p className="empty-title">{title}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}
