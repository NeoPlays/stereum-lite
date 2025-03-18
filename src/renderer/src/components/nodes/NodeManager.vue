<template>
    <div class="node-manager">
        <div class="node-manager-list">
            <div class="node-manager-node" v-for="node in nodes" :key="node.name"">
                <span class="node-manager-node-name">{{ node.name }}</span>
                <span class="node-manager-node-host">{{ node.host }}</span>
            </div>
        </div>
        <button @click="$emit('addConnection')">Add Node Connection</button>
    </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'

const nodes = ref([])
const node = {
    name: 'Node 1',
    host: 'localhost'
}

onMounted(() => {
    console.log('NodeManager.vue mounted')
    nodes.value = [node]
})
</script>