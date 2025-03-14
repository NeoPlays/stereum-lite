<template>
    <div class="base-container">
        <SSHLogin />
    </div>
</template>
<script setup>
import SSHLogin from './components/SSHLogin.vue'
import { onMounted } from 'vue'

onMounted(() => {
    console.log('App.vue mounted')
    window.api.invoke('ping')
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
    background-color: #30343f;
    font-family: 'Courier New', Courier, monospace;
    color: #a1a6b4;
}
</style>
