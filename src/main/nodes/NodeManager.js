export class NodeManager {
    constructor() {
        this.nodes = []
    }

    addNode(node) {
        this.nodes.push(node)
    }

    removeNode(nodeId) {
        this.nodes = this.nodes.filter(node => node.id !== nodeId)
    }

    getNode(nodeId) {
        return this.nodes.find(node => node.id === nodeId)
    }

    getAllNodes() {
        return this.nodes.map(node => node.toDTO())
    }
}
