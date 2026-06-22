import { describe, it, expect, vi } from 'vitest'
import { BotPool } from './bot-pool.js'
import type { AgentBinding } from './router.js'

function fakeClient() {
  return {
    registerBot: vi.fn(async () => undefined),
    invite: vi.fn(async () => undefined),
    joinRoom: vi.fn(async () => undefined),
    resolveAlias: vi.fn(async (_a: string) => '!existing:example.com' as string | null),
    createRoom: vi.fn(async () => '!new:example.com'),
    sendMessage: vi.fn(async () => ({ event_id: '$x' })),
    sendCustomEvent: vi.fn(async () => ({ event_id: '$x' })),
    setDisplayName: vi.fn(async () => undefined),
  }
}

const agents: AgentBinding[] = [
  {
    name: 'architect',
    userId: '@architect:example.com',
    rooms: [{ alias: '!r1:example.com' }, { alias: '!r2:example.com' }],
    trigger: 'mention',
  },
  {
    name: 'monitor',
    userId: '@monitor:example.com',
    rooms: [{ alias: '!alerts:example.com' }],
    trigger: 'any',
  },
]

describe('BotPool.bootstrap', () => {
  it('registers each bot and joins each of its rooms', async () => {
    const client = fakeClient()
    const pool = new BotPool(client, agents)
    await pool.bootstrap()
    expect(client.registerBot).toHaveBeenCalledWith('architect')
    expect(client.registerBot).toHaveBeenCalledWith('monitor')
    expect(client.joinRoom).toHaveBeenCalledWith('!r1:example.com', '@architect:example.com')
    expect(client.joinRoom).toHaveBeenCalledWith('!r2:example.com', '@architect:example.com')
    expect(client.joinRoom).toHaveBeenCalledWith('!alerts:example.com', '@monitor:example.com')
  })

  it('continues when one bot fails to register (logs but does not abort)', async () => {
    const client = fakeClient()
    client.registerBot.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const pool = new BotPool(client, agents)
    await pool.bootstrap()
    expect(client.registerBot).toHaveBeenCalledTimes(2)
    // monitor's rooms still joined despite architect failure
    expect(client.joinRoom).toHaveBeenCalledWith('!alerts:example.com', '@monitor:example.com')
  })

  it('looks up an agent binding by user id', () => {
    const client = fakeClient()
    const pool = new BotPool(client, agents)
    expect(pool.findByUserId('@architect:example.com')?.name).toBe('architect')
    expect(pool.findByUserId('@nobody:example.com')).toBeUndefined()
  })

  it('looks up an agent binding by name', () => {
    const client = fakeClient()
    const pool = new BotPool(client, agents)
    expect(pool.findByName('monitor')?.userId).toBe('@monitor:example.com')
  })
})

describe('BotPool.bootstrap — create-if-missing rooms', () => {
  it('creates a room when a configured #alias does not resolve', async () => {
    const calls: string[] = []
    const client = {
      registerBot: async () => {},
      setDisplayName: async () => {},
      resolveAlias: async (a: string) => {
        calls.push(`resolve:${a}`)
        return null
      },
      createRoom: async (opts: {
        roomAliasName: string
        invite: string[]
        senderUserId: string
      }) => {
        calls.push(`create:${opts.roomAliasName}:${opts.invite.join(',')}`)
        return '!new:localhost'
      },
      joinRoom: async (room: string, asUser: string) => {
        calls.push(`join:${asUser}->${room}`)
      },
    }
    const pool = new BotPool(client as never, [
      {
        name: 'echo',
        userId: '@echo:localhost',
        rooms: [{ alias: '#welcome:localhost' }],
        trigger: 'mention',
      },
    ])
    await pool.bootstrap({ adminUserId: '@admin:localhost' })

    expect(calls).toEqual([
      'resolve:#welcome:localhost',
      'create:welcome:@admin:localhost',
      'join:@echo:localhost->!new:localhost',
    ])
  })

  it('joins the existing room when createRoom loses a race (alias taken)', async () => {
    // Another agent/process created the room first: the alias didn't resolve at
    // first check, createRoom then fails (alias in use), and a re-resolve finds
    // it. We must join that room — not leave an orphan.
    const calls: string[] = []
    let resolveCount = 0
    const client = {
      registerBot: async () => {},
      setDisplayName: async () => {},
      resolveAlias: async (a: string) => {
        resolveCount++
        // First check: not found (we'll try to create). After the failed
        // create, the re-resolve finds the room the concurrent creator made.
        const r = resolveCount === 1 ? null : '!raced:localhost'
        calls.push(`resolve:${a}->${r ?? 'null'}`)
        return r
      },
      createRoom: async () => {
        calls.push('create:THROWS(alias in use)')
        throw new Error('createRoom(welcome) failed: 409 M_ROOM_IN_USE')
      },
      joinRoom: async (room: string, asUser: string) => {
        calls.push(`join:${asUser}->${room}`)
      },
    }
    const pool = new BotPool(client as never, [
      {
        name: 'echo',
        userId: '@echo:localhost',
        rooms: [{ alias: '#welcome:localhost' }],
        trigger: 'mention',
      },
    ])
    await pool.bootstrap({ adminUserId: '@admin:localhost' })
    expect(calls).toEqual([
      'resolve:#welcome:localhost->null',
      'create:THROWS(alias in use)',
      'resolve:#welcome:localhost->!raced:localhost',
      'join:@echo:localhost->!raced:localhost',
    ])
  })

  it('rethrows when createRoom fails and the alias still does not resolve', async () => {
    const client = {
      registerBot: async () => {},
      setDisplayName: async () => {},
      resolveAlias: async () => null, // never resolves — genuine creation failure
      createRoom: async () => {
        throw new Error('createRoom(welcome) failed: 500 boom')
      },
      joinRoom: vi.fn(async () => undefined),
    }
    const pool = new BotPool(client as never, [
      {
        name: 'echo',
        userId: '@echo:localhost',
        rooms: [{ alias: '#welcome:localhost' }],
        trigger: 'mention',
      },
    ])
    // bootstrap swallows per-room errors (logs); the room is never joined.
    await pool.bootstrap({ adminUserId: '@admin:localhost' })
    expect(client.joinRoom).not.toHaveBeenCalled()
  })

  it('skips create when the alias already resolves', async () => {
    const calls: string[] = []
    const client = {
      registerBot: async () => {},
      setDisplayName: async () => {},
      resolveAlias: async () => '!existing:localhost',
      createRoom: async () => {
        throw new Error('should not be called')
      },
      joinRoom: async (room: string, asUser: string) => {
        calls.push(`join:${asUser}->${room}`)
      },
    }
    const pool = new BotPool(client as never, [
      {
        name: 'echo',
        userId: '@echo:localhost',
        rooms: [{ alias: '#welcome:localhost' }],
        trigger: 'mention',
      },
    ])
    await pool.bootstrap({ adminUserId: '@admin:localhost' })
    expect(calls).toEqual(['join:@echo:localhost->!existing:localhost'])
  })

  it("rewrites the binding's rooms array with resolved IDs so the router can match", async () => {
    const client = {
      registerBot: async () => {},
      setDisplayName: async () => {},
      resolveAlias: async () => '!resolved:localhost',
      createRoom: async () => '!unused:localhost',
      joinRoom: async () => {},
    }
    const binding: AgentBinding = {
      name: 'echo',
      userId: '@echo:localhost',
      rooms: [{ alias: '#welcome:localhost' }],
      trigger: 'mention',
    }
    const pool = new BotPool(client as never, [binding])
    await pool.bootstrap({ adminUserId: '@admin:localhost' })
    expect(binding.rooms).toEqual([{ alias: '!resolved:localhost' }])
  })

  it('passes through room IDs (starting with !) without resolving or creating', async () => {
    const calls: string[] = []
    const client = {
      registerBot: async () => {},
      setDisplayName: async () => {},
      resolveAlias: async () => {
        throw new Error('should not be called for !roomId')
      },
      createRoom: async () => {
        throw new Error('should not be called for !roomId')
      },
      joinRoom: async (room: string, asUser: string) => {
        calls.push(`join:${asUser}->${room}`)
      },
    }
    const pool = new BotPool(client as never, [
      {
        name: 'echo',
        userId: '@echo:localhost',
        rooms: [{ alias: '!abc:localhost' }],
        trigger: 'mention',
      },
    ])
    await pool.bootstrap({ adminUserId: '@admin:localhost' })
    expect(calls).toEqual(['join:@echo:localhost->!abc:localhost'])
  })
})

describe('BotPool.bootstrap workforce-space attachment', () => {
  it('writes m.space.child for each resolved agent room when spaceRoomId is provided', async () => {
    const sendStateEvent = vi.fn(async () => ({ event_id: '$ev' }))
    const joinRoom = vi.fn(async () => undefined)
    const registerBot = vi.fn(async () => undefined)
    const resolveAlias = vi.fn(async (alias: string) =>
      alias === '#welcome:zoon.local' ? '!welcome:zoon.local' : null,
    )
    const createRoom = vi.fn(async () => '!created:zoon.local')

    const pool = new BotPool(
      {
        registerBot,
        invite: vi.fn(async () => undefined),
        joinRoom,
        resolveAlias,
        createRoom,
        sendStateEvent,
        setDisplayName: vi.fn(async () => undefined),
      } as never,
      [
        {
          name: 'planner',
          userId: '@planner:zoon.local',
          rooms: [{ alias: '#welcome:zoon.local' }],
          trigger: 'mention',
        },
      ],
    )

    await pool.bootstrap({
      adminUserId: '@admin:zoon.local',
      spaceRoomId: '!space:zoon.local',
      asUserId: '@zooid:zoon.local',
    })

    expect(sendStateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: '!space:zoon.local',
        eventType: 'm.space.child',
        stateKey: '!welcome:zoon.local',
        asUserId: '@zooid:zoon.local',
        content: expect.objectContaining({ via: ['zoon.local'] }),
      }),
    )
  })

  it('creates agent rooms restricted to the workforce space when spaceRoomId is set', async () => {
    const createRoom = vi.fn(async () => '!created:zoon.local')
    const pool = new BotPool(
      {
        registerBot: vi.fn(async () => undefined),
        invite: vi.fn(async () => undefined),
        joinRoom: vi.fn(async () => undefined),
        resolveAlias: vi.fn(async () => null), // alias unknown → must create
        createRoom,
        sendStateEvent: vi.fn(async () => ({ event_id: '$ev' })),
        setDisplayName: vi.fn(async () => undefined),
      } as never,
      [
        {
          name: 'planner',
          userId: '@planner:zoon.local',
          rooms: [{ alias: '#design:zoon.local' }],
          trigger: 'mention',
        },
      ],
    )
    await pool.bootstrap({ spaceRoomId: '!space:zoon.local', asUserId: '@zooid:zoon.local' })
    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ roomAliasName: 'design', restrictedToSpaceId: '!space:zoon.local' }),
    )
  })

  it('does nothing extra when spaceRoomId is omitted', async () => {
    const sendStateEvent = vi.fn(async () => ({ event_id: '$ev' }))
    const pool = new BotPool(
      {
        registerBot: vi.fn(async () => undefined),
        invite: vi.fn(async () => undefined),
        joinRoom: vi.fn(async () => undefined),
        resolveAlias: vi.fn(async () => '!r:zoon.local'),
        createRoom: vi.fn(async () => '!r:zoon.local'),
        sendStateEvent,
        setDisplayName: vi.fn(async () => undefined),
      } as never,
      [
        {
          name: 'planner',
          userId: '@planner:zoon.local',
          rooms: [{ alias: '#r:zoon.local' }],
          trigger: 'mention',
        },
      ],
    )
    await pool.bootstrap({})
    expect(sendStateEvent).not.toHaveBeenCalled()
  })

  it('deduplicates the m.space.child write across agents sharing a room', async () => {
    const sendStateEvent = vi.fn(async () => ({ event_id: '$ev' }))
    const pool = new BotPool(
      {
        registerBot: vi.fn(async () => undefined),
        invite: vi.fn(async () => undefined),
        joinRoom: vi.fn(async () => undefined),
        resolveAlias: vi.fn(async () => '!shared:zoon.local'),
        createRoom: vi.fn(async () => '!shared:zoon.local'),
        sendStateEvent,
        setDisplayName: vi.fn(async () => undefined),
      } as never,
      [
        { name: 'a', userId: '@a:zoon.local', rooms: [{ alias: '#shared:zoon.local' }], trigger: 'any' },
        { name: 'b', userId: '@b:zoon.local', rooms: [{ alias: '#shared:zoon.local' }], trigger: 'any' },
      ],
    )
    await pool.bootstrap({ spaceRoomId: '!space:zoon.local', asUserId: '@zooid:zoon.local' })
    const childWrites = sendStateEvent.mock.calls.filter(
      ([opts]) => (opts as { eventType: string }).eventType === 'm.space.child',
    )
    expect(childWrites).toHaveLength(1)
  })
})

describe('BotPool.bootstrap agent space membership', () => {
  it('invites the agent to the space (via the AS bot) then joins it as the agent', async () => {
    const invite = vi.fn(async () => undefined)
    const joinRoom = vi.fn(async () => undefined)
    const pool = new BotPool(
      {
        registerBot: vi.fn(async () => undefined),
        invite,
        joinRoom,
        resolveAlias: vi.fn(async () => '!r:zoon.local'),
        createRoom: vi.fn(async () => '!r:zoon.local'),
        sendStateEvent: vi.fn(async () => ({ event_id: '$ev' })),
        setDisplayName: vi.fn(async () => undefined),
      } as never,
      [
        {
          name: 'planner',
          userId: '@planner:zoon.local',
          rooms: [{ alias: '#r:zoon.local' }],
          trigger: 'mention',
        },
      ],
    )
    await pool.bootstrap({
      spaceRoomId: '!space:zoon.local',
      asUserId: '@zooid:zoon.local',
    })
    expect(invite).toHaveBeenCalledWith({
      roomId: '!space:zoon.local',
      asUserId: '@zooid:zoon.local',
      targetUserId: '@planner:zoon.local',
    })
    expect(joinRoom).toHaveBeenCalledWith('!space:zoon.local', '@planner:zoon.local')
  })

  it('skips space invite+join when spaceRoomId is not provided', async () => {
    const invite = vi.fn(async () => undefined)
    const pool = new BotPool(
      {
        registerBot: vi.fn(async () => undefined),
        invite,
        joinRoom: vi.fn(async () => undefined),
        resolveAlias: vi.fn(async () => '!r:zoon.local'),
        createRoom: vi.fn(async () => '!r:zoon.local'),
        sendStateEvent: vi.fn(async () => ({ event_id: '$ev' })),
        setDisplayName: vi.fn(async () => undefined),
      } as never,
      [
        {
          name: 'planner',
          userId: '@planner:zoon.local',
          rooms: [{ alias: '#r:zoon.local' }],
          trigger: 'mention',
        },
      ],
    )
    await pool.bootstrap({})
    expect(invite).not.toHaveBeenCalled()
  })
})

describe('BotPool.bootstrap creation-time power levels', () => {
  it('merges admin (PL 100) and per-agent declared PLs into createRoom userPowerLevels', async () => {
    const createRoom = vi.fn(async () => '!created:zoon.local')
    const pool = new BotPool(
      {
        registerBot: vi.fn(async () => undefined),
        invite: vi.fn(async () => undefined),
        joinRoom: vi.fn(async () => undefined),
        resolveAlias: vi.fn(async () => null), // force create
        createRoom,
        sendStateEvent: vi.fn(async () => ({ event_id: '$ev' })),
        setDisplayName: vi.fn(async () => undefined),
      } as never,
      [
        {
          name: 'planner',
          userId: '@planner:zoon.local',
          rooms: [{ alias: '#design:zoon.local' }], // default PL
          trigger: 'mention',
        },
        {
          name: 'mod',
          userId: '@mod:zoon.local',
          rooms: [{ alias: '#design:zoon.local', powerLevel: 50 }], // moderator
          trigger: 'mention',
        },
      ],
    )
    await pool.bootstrap({
      asUserId: '@zooid:zoon.local',
      spaceRoomId: '!space:zoon.local',
      adminUserIds: ['@admin:zoon.local'],
    })

    // First createRoom carries the merged map:
    //   bot @ 100, admin @ 100, mod @ 50 (planner has no declared PL → absent)
    const firstCall = createRoom.mock.calls[0]?.[0] as {
      userPowerLevels?: Record<string, number>
    }
    expect(firstCall.userPowerLevels).toEqual({
      '@zooid:zoon.local': 100,
      '@admin:zoon.local': 100,
      '@mod:zoon.local': 50,
    })
  })

  it('omits userPowerLevels when no admin and no agent declares a PL for the room', async () => {
    const createRoom = vi.fn(async () => '!r:zoon.local')
    const pool = new BotPool(
      {
        registerBot: vi.fn(async () => undefined),
        invite: vi.fn(async () => undefined),
        joinRoom: vi.fn(async () => undefined),
        resolveAlias: vi.fn(async () => null),
        createRoom,
        sendStateEvent: vi.fn(async () => ({ event_id: '$ev' })),
        setDisplayName: vi.fn(async () => undefined),
      } as never,
      [
        {
          name: 'plain',
          userId: '@plain:zoon.local',
          rooms: [{ alias: '#plain:zoon.local' }],
          trigger: 'mention',
        },
      ],
    )
    await pool.bootstrap({ spaceRoomId: '!space:zoon.local' })
    const opts = createRoom.mock.calls[0]?.[0] as {
      userPowerLevels?: Record<string, number>
    }
    expect(opts.userPowerLevels).toBeUndefined()
  })
})

describe('BotPool.bootstrap — display name', () => {
  it('falls back to the user_id localpart when no displayName is supplied', async () => {
    const client = fakeClient()
    const pool = new BotPool(client, [
      {
        name: 'docs',
        userId: '@docs:example.com',
        rooms: [],
        trigger: 'mention',
      },
    ])
    await pool.bootstrap()
    expect(client.setDisplayName).toHaveBeenCalledWith('@docs:example.com', 'docs')
  })

  it('writes the supplied displayName when present', async () => {
    const client = fakeClient()
    const pool = new BotPool(client, [
      {
        name: 'docs',
        userId: '@docs:example.com',
        displayName: 'Docs Agent',
        rooms: [],
        trigger: 'mention',
      },
    ])
    await pool.bootstrap()
    expect(client.setDisplayName).toHaveBeenCalledWith('@docs:example.com', 'Docs Agent')
  })

  it('passes the alias localpart as m.room.name when creating a room', async () => {
    const createRoom = vi.fn(async () => '!new:localhost')
    const client = {
      registerBot: vi.fn(async () => undefined),
      resolveAlias: vi.fn(async () => null),
      createRoom,
      joinRoom: vi.fn(async () => undefined),
      setDisplayName: vi.fn(async () => undefined),
    }
    const pool = new BotPool(client as never, [
      {
        name: 'echo',
        userId: '@echo:localhost',
        rooms: [{ alias: '#welcome:localhost' }],
        trigger: 'mention',
      },
    ])
    await pool.bootstrap({ adminUserId: '@admin:localhost' })
    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ roomAliasName: 'welcome', name: 'welcome' }),
    )
  })
})
