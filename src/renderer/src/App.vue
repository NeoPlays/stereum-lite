<template>
    <div class="base-container">
        <NodeManager v-if="nodeManagerActive" @add-connection="nodeManagerActive = false" />
        <SSHLogin v-else @login="nodeManagerActive = true"/>
    </div>
</template>
<script setup>

import { onMounted, ref } from 'vue'
import SSHLogin from './components/ssh/SSHLogin.vue'
import NodeManager from './components/nodes/NodeManager.vue'

const nodeManagerActive = ref(true)

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
    color: black;
    gap: 20px;
}
</style>
