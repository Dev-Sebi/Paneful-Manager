import type { WsEvents } from '@/api/ws'
import type { CreateFileRequest, FileContent, FileEntry } from '@agent-hub/shared'
import { FileConflictDetailsSchema, SkillDeleteBlockedDetailsSchema } from '@agent-hub/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, ApiClientError } from '@/api/client'

export interface FileConflict {
  /** Hash currently on disk; null when the file no longer exists. */
  currentHash: string | null
}

/** Set when the open file changed or was removed on disk after it was loaded. */
export interface DiskChange {
  removed: boolean
  hash?: string
}

function messageOf (error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export const useFilesStore = defineStore('files', () => {
  const entries = ref<FileEntry[]>([])
  const loading = ref(false)
  /** Failures of listing, opening and reloading; shown outside the editor. */
  const error = ref<string>()
  /** Failures of saving and deleting the open file. */
  const fileError = ref<string>()

  const current = ref<FileContent>()
  const buffer = ref('')
  const saving = ref(false)
  const conflict = ref<FileConflict>()
  const diskChange = ref<DiskChange>()

  let openToken = 0
  let listRunning = false
  let listAgain = false

  const dirty = computed(() => current.value !== undefined && buffer.value !== current.value.content)

  /** Loads the list; calls arriving while a load runs are coalesced into one follow-up load. */
  async function load () {
    if (listRunning) {
      listAgain = true
      return
    }
    listRunning = true
    loading.value = true
    try {
      do {
        listAgain = false
        try {
          entries.value = (await api.listFiles()).files
          error.value = undefined
        } catch (error_) {
          error.value = messageOf(error_, 'Could not load files')
        }
      } while (listAgain)
    } finally {
      listRunning = false
      loading.value = false
    }
  }

  function setCurrent (file: FileContent) {
    current.value = file
    buffer.value = file.content
    conflict.value = undefined
    diskChange.value = undefined
    fileError.value = undefined
  }

  async function open (path: string): Promise<boolean> {
    const token = ++openToken
    try {
      const { file } = await api.readFile(path)
      if (token === openToken) {
        setCurrent(file)
        error.value = undefined
      }
      return token === openToken
    } catch (error_) {
      if (token === openToken) {
        error.value = messageOf(error_, 'Could not open the file')
      }
      return false
    }
  }

  function close () {
    openToken += 1
    current.value = undefined
    buffer.value = ''
    conflict.value = undefined
    diskChange.value = undefined
    fileError.value = undefined
  }

  function setBuffer (value: string) {
    buffer.value = value
  }

  /** Discards the editor buffer and loads the file from disk again. */
  async function reload (): Promise<void> {
    const path = current.value?.path
    if (!path) {
      return
    }
    try {
      setCurrent((await api.readFile(path)).file)
      error.value = undefined
    } catch (error_) {
      if (error_ instanceof ApiClientError && error_.code === 'not_found') {
        close()
      }
      error.value = messageOf(error_, 'Could not reload the file')
    }
    await load()
  }

  async function write (expectedHash: string | undefined): Promise<boolean> {
    const file = current.value
    if (!file) {
      return false
    }
    saving.value = true
    const content = buffer.value
    try {
      const saved = (await api.writeFile({ path: file.path, content, expectedHash })).file
      if (current.value?.path === file.path) {
        current.value = { ...saved, content }
        conflict.value = undefined
        diskChange.value = undefined
      }
      fileError.value = undefined
      void load()
      return true
    } catch (error_) {
      if (error_ instanceof ApiClientError && error_.code === 'conflict') {
        const details = FileConflictDetailsSchema.safeParse(error_.details)
        conflict.value = { currentHash: details.success ? details.data.currentHash : null }
        diskChange.value = undefined
      } else {
        fileError.value = messageOf(error_, 'Could not save the file')
      }
      return false
    } finally {
      saving.value = false
    }
  }

  /** Saves the buffer based on the loaded hash; a 409 fills `conflict`. */
  function save (): Promise<boolean> {
    return write(current.value?.hash)
  }

  async function diskHash (): Promise<string | undefined> {
    if (diskChange.value?.removed) {
      return undefined
    }
    if (diskChange.value?.hash) {
      return diskChange.value.hash
    }
    if (conflict.value) {
      return conflict.value.currentHash ?? undefined
    }
    const path = current.value?.path
    return path ? (await api.readFile(path)).file.hash : undefined
  }

  /** Saves the buffer over the version on disk, re-sending with the hash currently there. */
  async function overwrite (): Promise<boolean> {
    try {
      return await write(await diskHash())
    } catch (error_) {
      fileError.value = messageOf(error_, 'Could not save the file')
      return false
    }
  }

  async function create (request: CreateFileRequest, starter?: string): Promise<FileContent> {
    const { file } = await api.createFile(request)
    setCurrent(file)
    await load()
    if (starter !== undefined && file.content === '') {
      buffer.value = starter
      await save()
    }
    return current.value ?? file
  }

  /** Deletes a managed file or skill directory; closes the editor when it held the deleted file. */
  async function remove (path: string): Promise<boolean> {
    try {
      await api.deleteFile(path)
    } catch (error_) {
      const blocked = error_ instanceof ApiClientError && error_.code === 'conflict'
        ? SkillDeleteBlockedDetailsSchema.safeParse(error_.details)
        : undefined
      fileError.value = blocked?.success
        ? `The skill folder contains other entries: ${blocked.data.blocked.join(', ')}`
        : messageOf(error_, 'Could not delete')
      return false
    }
    const open = current.value?.path
    if (open === path || open?.startsWith(`${path}/`)) {
      close()
    }
    await load()
    return true
  }

  /** Subscribes to live file events; returns an unsubscribe function. */
  function bind (events: WsEvents) {
    return events.on('file.changed', message => {
      void load()
      const file = current.value
      if (!file || message.path !== file.path) {
        return
      }
      if (message.event === 'unlink') {
        if (dirty.value) {
          diskChange.value = { removed: true }
        } else {
          close()
        }
      } else if (message.hash !== file.hash) {
        if (dirty.value) {
          diskChange.value = { removed: false, hash: message.hash }
        } else {
          void reload()
        }
      }
    })
  }

  return {
    entries,
    loading,
    error,
    current,
    buffer,
    saving,
    conflict,
    diskChange,
    dirty,
    fileError,
    load,
    open,
    close,
    setBuffer,
    reload,
    save,
    overwrite,
    create,
    remove,
    bind,
  }
})
