import { defineStore } from 'pinia'
import { ref } from 'vue'
export const useChartStore = defineStore('chart', () => { const showVolume = ref(true); return { showVolume } })
