<template>
  <main class="ah-home">
    <h1 class="ah-home__title">Agent Hub</h1>
    <p class="ah-home__text">Run and supervise your terminal agents in one place.</p>
    <v-btn color="primary" variant="flat">Get started</v-btn>
    <EditorShowcase />
  </main>
</template>

<script lang="ts" setup>
  import EditorShowcase from '@/components/editor/EditorShowcase.vue'
</script>

<style scoped>
.ah-home {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: var(--ah-space-4);
  min-height: 100%;
  padding: var(--ah-space-8);
  color: var(--ah-color-fg-primary);
  background: var(--ah-color-bg-canvas);
}

.ah-home__title {
  font-size: var(--ah-font-size-2xl);
  font-weight: var(--ah-font-weight-semibold);
  line-height: var(--ah-font-line-height-tight);
}

.ah-home__text {
  color: var(--ah-color-fg-muted);
  font-size: var(--ah-font-size-lg);
}
</style>
