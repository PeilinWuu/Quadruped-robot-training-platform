import type { PropsWithChildren, ReactNode } from 'react'

export function Panel({ title, extra, className = '', children }: PropsWithChildren<{ title: string; extra?: ReactNode; className?: string }>) {
  return <section className={`panel ${className}`}><header className="panel-header"><span>{title}</span>{extra ?? <span className="panel-more">•••</span>}</header><div className="panel-body">{children}</div></section>
}
