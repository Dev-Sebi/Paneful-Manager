import { spawn } from 'node-pty'
import { PTY_TERM_NAME } from '../tmux/tmux.js'

export interface PtyProcess {
  onData: (listener: (data: Uint8Array | string) => void) => void
  onExit: (listener: (event: { exitCode: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
}

export interface PtySpawnOptions {
  cols: number
  rows: number
  cwd: string
  env: NodeJS.ProcessEnv
}

export type SpawnPty = (file: string, args: readonly string[], options: PtySpawnOptions) => PtyProcess

/** node-pty with `encoding: null`, so raw bytes reach the streaming decoder. */
export const spawnPty: SpawnPty = (file, args, { cols, rows, cwd, env }) => {
  const pty = spawn(file, [...args], { name: PTY_TERM_NAME, cols, rows, cwd, env, encoding: null })
  return {
    onData: listener => {
      pty.onData(listener)
    },
    onExit: listener => {
      pty.onExit(listener)
    },
    write: data => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
  }
}
