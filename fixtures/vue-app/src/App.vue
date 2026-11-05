<template>
  <div class="app">
    <UserCard :user="user" />
  </div>
</template>

<script setup lang="ts">
import UserCard from './components/UserCard.vue'
import { useAuth } from '@/composables/useAuth'
import { get } from './api'
import { ref } from 'vue'

const user = ref(null)
const auth = useAuth()
const data = get('/x')
</script>
