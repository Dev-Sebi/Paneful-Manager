<template>
  <!-- TEMPORARY: editor showcase, remove with HelloWorld.vue -->
  <section class="pm-editor-showcase">
    <PmCodeEditor v-model="text" ariaLabel="SKILL.md sample" path="skills/review/SKILL.md" />
  </section>
</template>

<script lang="ts" setup>
  import { ref } from 'vue'
  import PmCodeEditor from './PmCodeEditor.vue'

  const text = ref(`---
name: review
description: Review a branch for production readiness
allowed-tools: [Read, Grep]
---

# Review

Check the **diff** and report findings.
`)
</script>

<style scoped>
.pm-editor-showcase {
  width: min(720px, 100%);
  height: 280px;
}
</style>
