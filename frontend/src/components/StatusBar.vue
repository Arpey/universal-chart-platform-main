<script setup lang="ts">
defineProps<{ connected: boolean; count: number }>()
</script>
<template><footer><span class="dot" :class="{ online: connected }"></span>{{ connected ? '实时连接' : '连接中断' }}<span class="muted">· {{ count }} 根 K 线</span><span class="muted source">数据源 Binance Spot</span></footer></template>
