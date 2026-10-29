'use client'

import { useEffect } from 'react'
import { track } from '@vercel/analytics'

const refPattern = /^[a-z0-9-]{1,32}$/

/**
 * Records the `ref=<channel>` query parameter that every posted link carries.
 * Vercel Web Analytics drops query parameters, so the channel is sent as one
 * `referral` custom event on the first page load. The parameter is then
 * stripped from the URL, so it is not sent again on reload or carried into
 * later navigation.
 */
export function Referral() {
  useEffect(() => {
    const url = new URL(window.location.href)
    const ref = url.searchParams.get('ref')
    if (ref === null) return

    if (refPattern.test(ref)) {
      // The Analytics component creates this queue in its own effect. Create it
      // here too, so the event waits for the script whatever the effect order.
      window.va ??= (...params) => {
        ;(window.vaq ??= []).push(params)
      }
      track('referral', { ref })
    }

    url.searchParams.delete('ref')
    window.history.replaceState(null, '', url)
  }, [])

  return null
}
