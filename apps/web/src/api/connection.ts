import { ref } from 'vue'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

/** State of the WebSocket connection to the server; only the WS client writes it. */
export const connection = ref<ConnectionState>('connecting')
