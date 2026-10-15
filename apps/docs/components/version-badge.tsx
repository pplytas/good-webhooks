import { site } from '@/lib/site'

export function VersionBadge() {
  return (
    <a
      href={site.npmUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={`Latest version on npm: ${site.version}`}
      className="ms-3 border px-2 py-0.5 font-mono text-[11px] tracking-wide text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground whitespace-nowrap max-md:hidden"
    >
      {site.version}
    </a>
  )
}
