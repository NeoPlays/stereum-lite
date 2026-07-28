<template>
    <section class="section">
        <div class="state-message">
            Validator management is coming soon - key import/list/remove, voluntary exit, and
            EIP-3076 slashing-protection import/export.
        </div>
    </section>
</template>

<script setup>
// Placeholder so the reserved "Validators" tab has a home; wire real props/emits when built.
defineProps({
    services: { type: Array, default: () => [] },
})
</script>

<style scoped>
.state-message {
    color: var(--ev-c-text-2);
    font-size: var(--font-size-body);
    text-align: center;
    padding: var(--space-9);
}
</style>
