import type { Component } from 'vue'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import { darkTheme } from '@/styles/generated/theme'

type MountOptions = NonNullable<Parameters<typeof mount>[1]>

/** Mounts a component with the project Vuetify theme, attached to the document for focus tests. */
export function mountWithVuetify (component: Component, options: MountOptions = {}) {
  const vuetify = createVuetify({ theme: { defaultTheme: 'dark', themes: { dark: darkTheme } } })
  return mount(component, {
    attachTo: document.body,
    ...options,
    global: { ...options.global, plugins: [vuetify, ...(options.global?.plugins ?? [])] },
  })
}
