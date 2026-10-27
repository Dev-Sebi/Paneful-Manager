import { ref } from 'vue'

export type ConnectionState = 'unknown' | 'online' | 'offline'

/** Reachability of the Agent Hub server, fed by the REST and WebSocket clients. */
export const connection = ref<ConnectionState>('unknown')
