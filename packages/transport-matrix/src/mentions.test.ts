import { describe, it, expect } from 'vitest'
import { extractMentions, stripMention } from './mentions.js'

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

describe('stripMention', () => {
  it('removes the bot user ID and trims surrounding whitespace', () => {
    expect(stripMention('@docs:localhost just say hi', '@docs:localhost')).toBe('just say hi')
  })

  it('removes a trailing mention', () => {
    expect(stripMention('hey @docs:localhost', '@docs:localhost')).toBe('hey')
  })

  it('removes a mid-sentence mention without doubling spaces', () => {
    expect(stripMention('hey @docs:localhost can you help', '@docs:localhost')).toBe(
      'hey can you help',
    )
  })

  it('leaves other users’ mentions untouched', () => {
    expect(stripMention('@docs:localhost cc @qa:example.com', '@docs:localhost')).toBe(
      'cc @qa:example.com',
    )
  })

  it('removes every occurrence of the bot mention', () => {
    expect(stripMention('@docs:localhost ping @docs:localhost again', '@docs:localhost')).toBe(
      'ping again',
    )
  })

  it('returns empty string when the body is just the mention', () => {
    expect(stripMention('@docs:localhost', '@docs:localhost')).toBe('')
  })
})
