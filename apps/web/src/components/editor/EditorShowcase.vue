<template>
  <!-- TEMPORARY: editor showcase, remove with HelloWorld.vue -->
  <section class="ah-editor-showcase">
    <AhCodeEditor v-model="text" v-bind="{ ariaLabel: label }" path="skills/review/SKILL.md" />
  </section>
</template>

<script lang="ts" setup>
  import { ref } from 'vue'
  import AhCodeEditor from './AhCodeEditor.vue'

  const label = 'SKILL.md sample'
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
.ah-editor-showcase {
  width: min(720px, 100%);
  height: 280px;
}
</style>
