import type { ReactNode } from 'react'

export function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    search: 'M10.8 18.6a7.8 7.8 0 1 1 0-15.6 7.8 7.8 0 0 1 0 15.6ZM16.5 16.5 22 22',
    sliders: 'M4 6h16M7 12h10M10 18h4',
    download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 18v3h16v-3',
    plus: 'M12 5v14M5 12h14',
    link: 'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    file: 'M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h4',
    check: 'm5 12 4 4L19 6',
    alert: 'M12 9v4m0 4h.01M10.3 3.2 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0Z',
    clock: 'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    close: 'm6 6 12 12M18 6 6 18',
    shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6',
    grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    people: 'M9 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2M17 5a4 4 0 0 1 0 8m2 2a5 5 0 0 1 3 4v2',
  }
  return <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] ?? paths.file} /></svg>
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}><span />{children}</span>
}
