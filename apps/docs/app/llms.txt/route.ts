import { docsLlms } from '@/lib/llms'
import { site } from '@/lib/site'

export const dynamic = 'force-static'

export async function GET() {
  const index = await docsLlms.index()
  const body = [
    `# ${site.name}`,
    '',
    `> ${site.description} Good Webhooks is an embedded TypeScript library for outbound webhooks: endpoint management, typed event publication, signed Standard Webhooks delivery with retries and replay, and receiver verification. It runs on Node.js 24 with PostgreSQL, and optionally manages endpoints through a Better Auth plugin.`,
    '',
    `Full documentation as one file: ${site.url}/llms-full.txt`,
    '',
    index,
  ].join('\n')
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
