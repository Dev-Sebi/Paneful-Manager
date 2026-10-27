/** Streaming UTF-8 decoder: multi-byte characters split across chunks are joined, invalid bytes become U+FFFD. */
export class Utf8StreamDecoder {
  private readonly decoder = new TextDecoder('utf-8')

  decode(chunk: Uint8Array | string): string {
    return typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
  }

  /** Flushes an incomplete trailing sequence. */
  end(): string {
    return this.decoder.decode()
  }
}
