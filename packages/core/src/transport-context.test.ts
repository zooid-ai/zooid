import { describe, it, expectTypeOf } from 'vitest'
import type {
  TransportContextProvider,
  HistoryPage,
  Message,
  Member,
  ChannelInfo,
} from './transport-context.js'
import type { ThreadRef } from './types.js'

describe('TransportContextProvider', () => {
  it('declares the three read methods with the spec shape', () => {
    expectTypeOf<TransportContextProvider['getThreadHistory']>().parameters.toEqualTypeOf<
      [ThreadRef, { limit?: number; before?: string }]
    >()
    expectTypeOf<TransportContextProvider['getThreadHistory']>().returns.resolves.toEqualTypeOf<HistoryPage>()
    expectTypeOf<TransportContextProvider['getChannelMembers']>().returns.resolves.toEqualTypeOf<Member[]>()
    expectTypeOf<TransportContextProvider['getChannelInfo']>().returns.resolves.toEqualTypeOf<ChannelInfo>()
  })

  it('ChannelInfo.transport is the two-transport MVP union', () => {
    expectTypeOf<ChannelInfo['transport']>().toEqualTypeOf<'http' | 'matrix'>()
  })

  it('Message and Member carry the is_agent flag', () => {
    expectTypeOf<Message['is_agent']>().toEqualTypeOf<boolean>()
    expectTypeOf<Member['is_agent']>().toEqualTypeOf<boolean>()
  })
})
