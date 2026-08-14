// Per-service capability sets for the Validators view. Actions are NOT universal: a local
// validator client (solo VC) can set fee recipient / graffiti / exit / remove keys, while an
// Obol Charon (distributed validators) or a shared VC behind Charon can only read/monitor -
// mutations there are multi-party, coordinated off-node via the Obol DV Launchpad.
//
// Keyed by the `role` the Validators tab already derives per service (validatorSetup.roleOf):
//   'validator'   solo VC - full local lifecycle
//   'share'       VC behind Charon - holds one key share, read-only + multi-party
//   'distributed' CharonService - the cluster's DV pubkeys from cluster-lock.json, read-only
//   'signer'      Web3Signer - remote keys, manage on the VC not here
//   'ssv'         SSV operator - registration/exit are on-chain, off-node
//
// Each action carries flags the UI honors: `danger` (destructive styling), `mutating` (writes
// on-node), `implemented` (the pipeline behind it exists - a mutating action WITHOUT this is
// rendered disabled with a "soon" hint), `needsGraffiti` (needs the client to expose the
// graffiti route, which is version-gated), `needsIndex` (needs the beacon index, so disabled
// until that data is fetched), `hint` (right-aligned menu hint).
//
// `mutating` is a statement about what the action does, not about whether it is available -
// keep it set even once implemented, so anything reasoning about destructiveness stays correct.

const A = {
    setFeeRecipient: { id: 'setFeeRecipient', label: 'Set fee recipient', mutating: true, implemented: true },
    setGraffiti:     { id: 'setGraffiti', label: 'Set graffiti', mutating: true, implemented: true, needsGraffiti: true },
    copyPubkey:      { id: 'copyPubkey', label: 'Copy full pubkey' },
    copyPubkeys:     { id: 'copyPubkeys', label: 'Copy pubkeys' },
    viewBeaconcha:   { id: 'viewBeaconcha', label: 'View on beaconcha.in', hint: 'open', needsIndex: true },
    exportCsv:       { id: 'exportCsv', label: 'Export CSV' },
    exitValidator:   { id: 'exitValidator', label: 'Exit validator', danger: true, mutating: true, hint: 'irreversible' },
    removeKey:       { id: 'removeKey', label: 'Remove key', danger: true, mutating: true, implemented: true, hint: 'keeps validator active' },
    exitValidators:  { id: 'exitValidators', label: 'Exit validators', danger: true, mutating: true },
    removeKeys:      { id: 'removeKeys', label: 'Remove keys', danger: true, mutating: true, implemented: true },
    clusterDetails:  { id: 'clusterDetails', label: 'Cluster details' },
    exitViaLaunchpad:{ id: 'exitViaLaunchpad', label: 'Exit via Launchpad', hint: 'multi-party', disabled: true },
    openLaunchpad:   { id: 'openLaunchpad', label: 'Open in Launchpad', hint: 'open' },
}

// note is a template with {client} replaced by the service's short name at render time.
const CAPABILITIES = {
    validator: {
        rowActions: [A.setFeeRecipient, A.setGraffiti, A.copyPubkey, A.viewBeaconcha, A.exitValidator, A.removeKey],
        scopeActions: [A.setFeeRecipient, A.setGraffiti, A.exportCsv, A.exitValidators, A.removeKeys],
        drawerActions: [A.setFeeRecipient, A.setGraffiti, A.copyPubkey, A.exitValidator, A.removeKey],
        note: 'Validator keys held by this {client} instance. Fee recipient and graffiti apply immediately; exits and key removal are irreversible on this node.',
    },
    share: {
        rowActions: [A.copyPubkey, A.viewBeaconcha, A.exitViaLaunchpad],
        scopeActions: [A.copyPubkeys, A.exportCsv, A.openLaunchpad],
        drawerActions: [A.copyPubkey, A.viewBeaconcha, A.exitViaLaunchpad],
        note: 'Obol key shares held by this {client} behind Charon. This node holds one share of each distributed validator; exits and key removal are multi-party actions coordinated through the Obol DV Launchpad.',
    },
    distributed: {
        rowActions: [A.copyPubkey, A.viewBeaconcha, A.clusterDetails, A.exitViaLaunchpad],
        scopeActions: [A.copyPubkeys, A.exportCsv, A.openLaunchpad],
        drawerActions: [A.copyPubkey, A.viewBeaconcha, A.exitViaLaunchpad],
        note: 'Distributed validators (Obol). Keys are read from cluster-lock.json. Adding validators, exits, and key removal are multi-party actions coordinated through the Obol DV Launchpad - this node can read and monitor, but cannot act alone.',
    },
    signer: {
        rowActions: [A.copyPubkey, A.viewBeaconcha],
        scopeActions: [A.copyPubkeys, A.exportCsv],
        drawerActions: [A.copyPubkey, A.viewBeaconcha],
        note: 'Keys held by this Web3Signer. Validator clients pointed at it sign remotely - manage fee recipient and exits on the validator client, not here.',
    },
    ssv: {
        rowActions: [], scopeActions: [], drawerActions: [],
        note: 'SSV operator node. Validator registration, exit, and removal are wallet-driven, multi-operator actions performed in the SSV web app - not local key operations.',
    },
}

const EMPTY = { rowActions: [], scopeActions: [], drawerActions: [], note: '' }

/**
 * Capability set for a role, with {client} substituted into the note.
 * @returns {{ rowActions, scopeActions, drawerActions, note }}
 */
export function capabilityFor(role, clientName = '') {
    const cap = CAPABILITIES[role] || EMPTY
    return { ...cap, note: cap.note.replace('{client}', clientName) }
}

/**
 * Single source of truth for whether an action may be clicked. The row menu, the scope bar, and
 * the detail drawer all defer to this - they used to each carry their own copy of the rule, which
 * is exactly how a mutating action ends up enabled in one surface and disabled in another.
 *
 * @param {object} action - an entry from the capability sets above
 * @param {{ row?: object, soloEligible?: boolean, graffitiSupported?: boolean }} ctx
 */
export function actionDisabled(action, { row = null, soloEligible = true, graffitiSupported = true } = {}) {
    if (!action || action.disabled) return true
    // A mutating action needs both a pipeline behind it and a setup we may act on alone.
    if (action.mutating && (!action.implemented || !soloEligible)) return true
    if (action.needsGraffiti && !graffitiSupported) return true
    if (action.needsIndex && (!row || row.index == null)) return true
    return false
}

/** The muted hint shown beside an action, explaining why it is unavailable when it is. */
export function actionHint(action, { row = null, soloEligible = true, graffitiSupported = true } = {}) {
    if (!action) return ''
    if (action.mutating && !action.implemented) return 'soon'
    if (action.mutating && !soloEligible) return 'multi-party'
    if (action.needsGraffiti && !graffitiSupported) return 'unsupported'
    if (action.needsIndex && (!row || row.index == null)) return 'no index'
    return action.hint || ''
}

// beaconcha.in host per network (index-keyed validator page). Unknown networks -> null.
const EXPLORER_HOST = {
    mainnet: 'https://beaconcha.in',
    holesky: 'https://holesky.beaconcha.in',
    hoodi: 'https://hoodi.beaconcha.in',
    sepolia: 'https://sepolia.beaconcha.in',
    gnosis: 'https://gnosischa.in',
}

/** beaconcha.in validator URL for a network + index, or null if either is unknown. */
export function explorerUrl(network, index) {
    const host = EXPLORER_HOST[String(network || '').toLowerCase()]
    return host && index != null ? `${host}/validator/${index}` : null
}
