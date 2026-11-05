<template>
  <article class="card">{{ user?.name ?? fallback }}</article>
</template>

<script setup lang="ts">
defineProps<{ user: { id: number; name: string } | null }>()

const fallback = 'unknown'
</script>
