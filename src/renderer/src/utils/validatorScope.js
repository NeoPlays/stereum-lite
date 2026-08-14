// Resolving which validator keys a bulk action applies to.
//
// Extracted from ValidatorsTab because getting this wrong is silent and expensive: the scope bar
// renders a count, and a bulk action writes to a set of keys. If those two disagree, the UI says
// "200 keys" and the write touches 25, reporting "25 of 25 updated" with no error anywhere. That
// is exactly the bug this replaced, so the rule now lives in one tested function instead of being
// derived twice.
//
// The three scopes:
//   'all'      every key held by the service
//   'filtered' every key matching the current search/facet/chips
//   'selected' the checked keys - OR, once "select all N matching" is used, every filtered key
//
// `allMatching` is the flag set by the "Select all N matching" link. That link's label counts the
// FILTERED rows, so the flag must resolve to the filtered set, never to every key on the service.

/**
 * The rows a scope action targets.
 * @param {{ scope: string, allMatching: boolean, rows: object[], visible: object[], selected: Set }} state
 * @returns {object[]}
 */
export function scopeTargets({ scope, allMatching = false, rows = [], visible = [], selected = new Set() }) {
    if (scope === 'filtered') return visible
    if (scope === 'selected') return allMatching ? visible : rows.filter((r) => selected.has(r.pubkey))
    return rows
}

/**
 * How many keys the current selection represents. Must be derived from the same rule as
 * scopeTargets, or the number shown and the number written diverge.
 */
export function selectionCount({ allMatching = false, visible = [], selected = new Set() }) {
    return allMatching ? visible.length : selected.size
}

/**
 * The scope actually in force. A "selected" scope with nothing selected would target nothing,
 * which reads as a broken button, so it falls back to "all".
 */
export function effectiveScopeOf({ scope, allMatching = false, visible = [], selected = new Set() }) {
    if (scope === 'selected' && selectionCount({ allMatching, visible, selected }) === 0) return 'all'
    return scope
}

/** The count rendered in the scope bar, for the scope actually in force. */
export function scopeCountOf(state) {
    const scope = effectiveScopeOf(state)
    if (scope === 'all') return (state.rows || []).length
    if (scope === 'filtered') return (state.visible || []).length
    return selectionCount(state)
}
