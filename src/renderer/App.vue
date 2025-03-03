<template>
  <div class="base-container">
    <SSHLogin />
  </div>
</template>
<script setup>
  import SSHLogin from './Components/SSHLogin.vue'  
  import { onMounted } from 'vue'
  import { ipcApi } from '@/renderer/ipc/ipcApi'
  onMounted(() => {
    ipcApi.getAppVersion().then((data) => {
      console.log(data)
    })
  })
</script>
<style scoped>
/*https://coolors.co/94c5cc-b4d2e7-a1a6b4-30343f-3d4250*/
  .base-container {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    width: 100vw;
    background-color: #30343F;
    font-family:'Courier New', Courier, monospace;
    color: #A1A6B4;
  }
</style>