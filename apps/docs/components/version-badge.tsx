import { site } from '@/lib/site'

export function VersionBadge() {
  return (
    <a
      href={site.npmUrl}
      target="_blank"
      rel="noreferrer"
      className="mb-2 flex flex-col gap-0.5 rounded-lg border px-3 py-2 transition-colors hover:bg-fd-accent"
    >
      <span className="text-xs text-fd-muted-foreground">Latest version</span>
      <span className="font-mono text-sm">{site.version}</span>
    </a>
  )
}
