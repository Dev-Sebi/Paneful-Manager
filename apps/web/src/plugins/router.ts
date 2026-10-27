import type { Plugin } from 'vue'
import { createAppRouter } from '@/router'

export function createRouterPlugin (): Plugin {
  return createAppRouter()
}
