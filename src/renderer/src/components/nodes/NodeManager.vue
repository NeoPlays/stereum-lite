<template>
    <div class="node-manager">
        <div class="node-manager-list">
            <div class="node-manager-node" v-for="node in nodes">
                <span class="node-name">{{ node.name }}</span>
                <span class="node-host">{{ node.host }}</span>
            </div>
        </div>
        <button @click="$emit('addConnection')">Add Node Connection</button>
    </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useNodesStore } from '@stores/useNodes'
import { storeToRefs } from 'pinia'

const store = useNodesStore()

const { nodes } = storeToRefs(store)
const { refreshNodes } = store

onMounted(async () => {
    console.log('NodeManager.vue mounted')
    refreshNodes()
    console.log(nodes.value)
})
</script>

<style scoped>
.node-manager {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
}
.node-manager-list {
    display: flex;
    flex-direction: column;
    width: 80%;
    background-color: white;
}
.node-manager-node {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    padding: 10px;
    border-bottom: 1px solid #ccc;
}

</style>