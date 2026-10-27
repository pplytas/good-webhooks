import type { StandardSchemaV1 } from '@standard-schema/spec'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createWebhooks, describeEvents, type EventDefinitions } from '../src/index.js'
import type { Database } from '../src/types.js'

const order = z.object({
  id: z.string(),
  currency: z.string().default('EUR'),
  note: z.string().optional(),
})

// A Standard Schema validator without the Standard JSON Schema interface.
const plain: StandardSchemaV1<{ id: string }> = {
  '~standard': {
    version: 1,
    vendor: 'hand-written',
    validate: (value) => ({ value: value as { id: string } }),
  },
}

function withConverter(output: () => Record<string, unknown>): StandardSchemaV1 {
  return {
    '~standard': {
      ...plain['~standard'],
      jsonSchema: { input: output, output },
    } as StandardSchemaV1['~standard'],
  }
}

describe('describeEvents', () => {
  it('describes the validated output, so defaulted fields are required', () => {
    expect(describeEvents({ 'order.created': order })).toEqual([
      {
        type: 'order.created',
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            id: { type: 'string' },
            currency: { type: 'string', default: 'EUR' },
            note: { type: 'string' },
          },
          required: ['id', 'currency'],
          additionalProperties: false,
        },
      },
    ])
  })

  it('passes the target to the validator', () => {
    const [description] = describeEvents({ 'order.created': order }, { target: 'draft-07' })
    expect(description?.schema?.$schema).toBe('http://json-schema.org/draft-07/schema#')
  })

  it('follows the order of the events map', () => {
    const events = {
      'order.created': order,
      'account.activated': z.object({ accountId: z.string() }),
      'invoice.paid': z.object({ amount: z.number() }),
    }
    expect(describeEvents(events).map(({ type }) => type)).toEqual([
      'order.created',
      'account.activated',
      'invoice.paid',
    ])
  })

  it('returns a null schema for validators without Standard JSON Schema', () => {
    expect(describeEvents({ 'order.created': plain, 'order.paid': order })).toEqual([
      { type: 'order.created', schema: null },
      { type: 'order.paid', schema: expect.objectContaining({ type: 'object' }) },
    ])
  })

  it('names the event when a converter throws and keeps the cause', () => {
    const cause = new Error('Unsupported target: draft-04')
    const failing = withConverter(() => {
      throw cause
    })
    let error: unknown
    try {
      describeEvents({ 'order.created': order, 'order.failed': failing }, { target: 'draft-04' })
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({
      code: 'INVALID_CONFIG',
      message:
        'Event order.failed cannot be described as JSON Schema: Unsupported target: draft-04',
      cause,
    })
  })

  it('rejects a converter that returns no object', () => {
    const empty = withConverter(() => null as unknown as Record<string, unknown>)
    expect(() => describeEvents({ 'order.created': empty })).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        message: expect.stringContaining('order.created'),
      }),
    )
  })

  it('reports Zod transforms as INVALID_CONFIG', () => {
    const events = { 'order.created': z.object({ total: z.string().transform(Number) }) }
    expect(() => describeEvents(events)).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        message: expect.stringMatching(/^Event order\.created cannot be described.*Transforms/),
      }),
    )
  })

  it.each([
    ['no map', undefined],
    ['an empty map', {}],
    ['a reserved name', { 'good-webhooks.test': order }],
    ['an invalid name', { 'order created': order }],
    ['a non-validator', { 'order.created': {} }],
  ])('rejects %s with INVALID_CONFIG', (_, events) => {
    expect(() => describeEvents(events as unknown as EventDefinitions)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    )
  })

  it.each([
    ['null options', null],
    ['string options', 'draft-07'],
    ['array options', []],
    ['an empty target', { target: '' }],
    ['a numeric target', { target: 7 }],
    ['a null target', { target: null }],
  ])('rejects %s with INVALID_INPUT', (_, options) => {
    expect(() =>
      describeEvents({ 'order.created': order }, options as unknown as { target?: string }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('is available on the engine with the same result', () => {
    const events = { 'order.created': order, 'order.paid': plain }
    const webhooks = createWebhooks({
      database: { query: vi.fn(), connect: vi.fn() } as unknown as Database,
      encryptionKey: new Uint8Array(32).fill(7),
      events,
    })
    expect(webhooks.describeEvents()).toEqual(describeEvents(events))
    expect(webhooks.describeEvents({ target: 'draft-07' })).toEqual(
      describeEvents(events, { target: 'draft-07' }),
    )
  })
})
