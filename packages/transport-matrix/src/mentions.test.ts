import { describe, it, expect } from 'vitest'
import { extractMentions } from './mentions.js'

describe('extractMentions', () => {
  it('reads m.mentions.user_ids when present', () => {
    const event = {
      type: 'm.room.message',
      content: {
        msgtype: 'm.text',
        body: 'Hi @architect',
        'm.mentions': { user_ids: ['@architect:example.com'] },
      },
    }
    expect(extractMentions(event)).toEqual(['@architect:example.com'])
  })

  it('falls back to parsing formatted_body anchors', () => {
    const event = {
      type: 'm.room.message',
      content: {
        msgtype: 'm.text',
        body: 'Hi architect',
        format: 'org.matrix.custom.html',
        formatted_body:
          'Hi <a href="https://matrix.to/#/@architect:example.com">architect</a>',
      },
    }
    expect(extractMentions(event)).toEqual(['@architect:example.com'])
  })

  it('falls back to scanning body for raw user IDs', () => {
    const event = {
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'cc @qa:example.com please' },
    }
    expect(extractMentions(event)).toEqual(['@qa:example.com'])
  })

  it('returns empty when no mention is present', () => {
    const event = {
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'just chatting' },
    }
    expect(extractMentions(event)).toEqual([])
  })

  it('deduplicates IDs that appear in both m.mentions and the body', () => {
    const event = {
      type: 'm.room.message',
      content: {
        msgtype: 'm.text',
        body: 'cc @qa:example.com',
        'm.mentions': { user_ids: ['@qa:example.com'] },
      },
    }
    expect(extractMentions(event)).toEqual(['@qa:example.com'])
  })
})
