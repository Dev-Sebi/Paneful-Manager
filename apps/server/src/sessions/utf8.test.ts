import { describe, expect, it } from 'vitest'
import { Utf8StreamDecoder } from './utf8.js'

describe('Utf8StreamDecoder', () => {
  it('joins multi-byte characters split across chunks', () => {
    const bytes = new TextEncoder().encode('a€✓😀b')
    const decoder = new Utf8StreamDecoder()
    const parts: string[] = []
    for (const byte of bytes) {
      parts.push(decoder.decode(Uint8Array.of(byte)))
    }
    parts.push(decoder.end())
    expect(parts.join('')).toBe('a€✓😀b')
    expect(parts.every(part => !part.includes('�'))).toBe(true)
  })

  it('holds back an incomplete sequence until the rest arrives', () => {
    const decoder = new Utf8StreamDecoder()
    expect(decoder.decode(Uint8Array.of(0x61, 0xE2, 0x82))).toBe('a')
    expect(decoder.decode(Uint8Array.of(0xAC, 0x62))).toBe('€b')
  })

  it('replaces invalid bytes and passes strings through', () => {
    const decoder = new Utf8StreamDecoder()
    expect(decoder.decode(Uint8Array.of(0xFF, 0x61))).toBe('�a')
    expect(decoder.decode('plain')).toBe('plain')
    expect(decoder.decode(Uint8Array.of(0xE2))).toBe('')
    expect(decoder.end()).toBe('�')
  })
})
