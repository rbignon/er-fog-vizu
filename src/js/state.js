// ============================================================
// STATE - Centralized application state with event bus
// ============================================================

// Application state (single source of truth)
const state = {
    // Graph data
    graphData: null,
    seed: null,

    // Exploration mode
    explorationMode: true,  // true = Explorer, false = Full Spoiler
    explorationState: {
        discovered: new Set(['Chapel of Anticipation']),  // Start with starting area discovered
        discoveredLinks: new Set(),  // Links that have been explicitly traversed (format: "sourceId|targetId")
        tags: new Map()
    },
    frontierHighlightActive: false,
    
    // Graph visualization state
    nodePositions: new Map(),
    currentZoomTransform: null,
    selectedNodeId: null,
    simulation: null,
    
    // Sync state
    syncConnected: false,
    isStreamerHost: false,
    sessionCode: null,

    // Pending undiscover (to select placeholder after re-render)
    pendingUndiscoveredNodeId: null
};

// Event bus for inter-module communication
const listeners = new Map();

/**
 * Subscribe to a state change event
 * @param {string} event - Event name
 * @param {Function} callback - Function to call when event fires
 * @returns {Function} Unsubscribe function
 */
export function subscribe(event, callback) {
    if (!listeners.has(event)) {
        listeners.set(event, new Set());
    }
    listeners.get(event).add(callback);
    
    // Return unsubscribe function
    return () => listeners.get(event).delete(callback);
}

/**
 * Emit an event to all subscribers
 * @param {string} event - Event name
 * @param {*} data - Data to pass to subscribers
 */
export function emit(event, data) {
    if (listeners.has(event)) {
        listeners.get(event).forEach(callback => {
            try {
                callback(data);
            } catch (err) {
                console.error(`Error in event handler for "${event}":`, err);
            }
        });
    }
}

// ============================================================
// STATE GETTERS (read-only access)
// ============================================================

export function getGraphData() {
    return state.graphData;
}

export function getSeed() {
    return state.seed;
}

export function isExplorationMode() {
    return state.explorationMode;
}

export function getExplorationState() {
    return state.explorationState;
}

export function isFrontierHighlightActive() {
    return state.frontierHighlightActive;
}

export function getNodePositions() {
    return state.nodePositions;
}

export function getCurrentZoomTransform() {
    return state.currentZoomTransform;
}

export function getSelectedNodeId() {
    return state.selectedNodeId;
}

export function getSimulation() {
    return state.simulation;
}

export function isSyncConnected() {
    return state.syncConnected;
}

export function isStreamerHost() {
    return state.isStreamerHost;
}

export function getSessionCode() {
    return state.sessionCode;
}

// ============================================================
// STATE SETTERS (emit events on change)
// ============================================================

export function setGraphData(data) {
    state.graphData = data;
    emit('graphDataChanged', data);
}

export function setSeed(seed) {
    const oldSeed = state.seed;
    state.seed = seed;
    if (oldSeed !== seed) {
        emit('seedChanged', { oldSeed, newSeed: seed });
    }
}

export function setExplorationMode(mode) {
    const oldMode = state.explorationMode;
    state.explorationMode = mode;
    if (oldMode !== mode) {
        emit('explorationModeChanged', mode);
    }
}

export function setExplorationState(explorationState) {
    state.explorationState = explorationState;
    emit('explorationStateChanged', explorationState);
}

export function setFrontierHighlightActive(active) {
    state.frontierHighlightActive = active;
    emit('frontierHighlightChanged', active);
}

export function setCurrentZoomTransform(transform) {
    state.currentZoomTransform = transform;
    // No event - this changes too frequently
}

export function setSelectedNodeId(nodeId) {
    state.selectedNodeId = nodeId;
    emit('selectionChanged', nodeId);
}

export function setSimulation(sim) {
    state.simulation = sim;
}

export function setSyncState(connected, isHost, code) {
    state.syncConnected = connected;
    state.isStreamerHost = isHost;
    state.sessionCode = code;
    emit('syncStateChanged', { connected, isHost, code });
}

export function setPendingUndiscoveredNodeId(nodeId) {
    state.pendingUndiscoveredNodeId = nodeId;
}

export function getPendingUndiscoveredNodeId() {
    return state.pendingUndiscoveredNodeId;
}

export function clearPendingUndiscoveredNodeId() {
    state.pendingUndiscoveredNodeId = null;
}

// ============================================================
// EXPLORATION STATE HELPERS
// ============================================================

export function isDiscovered(nodeId) {
    return state.explorationState.discovered.has(nodeId);
}

export function discoverNode(nodeId) {
    if (!state.explorationState.discovered.has(nodeId)) {
        state.explorationState.discovered.add(nodeId);
        emit('nodeDiscovered', nodeId);
        return true;
    }
    return false;
}

export function undiscoverNode(nodeId) {
    if (state.explorationState.discovered.has(nodeId)) {
        state.explorationState.discovered.delete(nodeId);
        state.explorationState.tags.delete(nodeId);
        emit('nodeUndiscovered', nodeId);
        return true;
    }
    return false;
}

// ============================================================
// DISCOVERED LINKS HELPERS
// ============================================================

/**
 * Create a canonical link ID from source and target
 * Format: "sourceId|targetId"
 */
export function makeLinkId(sourceId, targetId) {
    return `${sourceId}|${targetId}`;
}

/**
 * Check if a link has been discovered (in either direction for bidirectional links)
 */
export function isLinkDiscovered(sourceId, targetId) {
    return state.explorationState.discoveredLinks.has(makeLinkId(sourceId, targetId));
}

/**
 * Mark a link as discovered
 * @param {string} sourceId - Source node ID
 * @param {string} targetId - Target node ID
 * @param {boolean} bidirectional - If true, also mark reverse direction
 */
export function discoverLink(sourceId, targetId, bidirectional = false) {
    const linkId = makeLinkId(sourceId, targetId);
    const added = !state.explorationState.discoveredLinks.has(linkId);

    state.explorationState.discoveredLinks.add(linkId);

    if (bidirectional) {
        state.explorationState.discoveredLinks.add(makeLinkId(targetId, sourceId));
    }

    if (added) {
        emit('linkDiscovered', { sourceId, targetId, bidirectional });
    }
    return added;
}

/**
 * Remove a link from discovered set
 */
export function undiscoverLink(sourceId, targetId) {
    const linkId = makeLinkId(sourceId, targetId);
    return state.explorationState.discoveredLinks.delete(linkId);
}

/**
 * Remove all discovered links involving a specific node
 */
export function undiscoverLinksForNode(nodeId) {
    const toRemove = [];
    state.explorationState.discoveredLinks.forEach(linkId => {
        const [source, target] = linkId.split('|');
        if (source === nodeId || target === nodeId) {
            toRemove.push(linkId);
        }
    });
    toRemove.forEach(linkId => state.explorationState.discoveredLinks.delete(linkId));
    return toRemove.length;
}

export function getNodeTags(nodeId) {
    return state.explorationState.tags.get(nodeId) || [];
}

export function setNodeTags(nodeId, tags) {
    if (tags && tags.length > 0) {
        state.explorationState.tags.set(nodeId, tags);
    } else {
        state.explorationState.tags.delete(nodeId);
    }
    emit('nodeTagsChanged', { nodeId, tags });
}

export function toggleNodeTag(nodeId, tagId) {
    const currentTags = getNodeTags(nodeId);
    const tagIndex = currentTags.indexOf(tagId);
    
    if (tagIndex >= 0) {
        currentTags.splice(tagIndex, 1);
    } else {
        currentTags.push(tagId);
    }
    
    setNodeTags(nodeId, currentTags);
    return currentTags;
}

// ============================================================
// NODE POSITIONS HELPERS
// ============================================================

export function saveNodePosition(nodeId, x, y) {
    if (typeof x === 'number' && typeof y === 'number' && 
        !isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) {
        state.nodePositions.set(nodeId, { x, y });
    }
}

export function getNodePosition(nodeId) {
    return state.nodePositions.get(nodeId);
}

export function saveAllNodePositions() {
    if (!state.simulation) return;
    
    state.simulation.nodes().forEach(node => {
        if (node.x !== undefined && node.y !== undefined) {
            saveNodePosition(node.id, node.x, node.y);
        }
    });
    
    emit('nodePositionsSaved');
}

export function clearNodePositions() {
    state.nodePositions.clear();
}

// ============================================================
// PERSISTENCE (localStorage)
// ============================================================

const STORAGE_KEY_PREFIX = 'er-fog-exploration-';

function getStorageKey(seed) {
    return STORAGE_KEY_PREFIX + seed;
}

export function saveExplorationToStorage() {
    if (!state.seed || !state.explorationState) return;

    const toSave = {
        discovered: Array.from(state.explorationState.discovered),
        discoveredLinks: Array.from(state.explorationState.discoveredLinks),
        tags: Object.fromEntries(state.explorationState.tags)
    };

    try {
        localStorage.setItem(getStorageKey(state.seed), JSON.stringify(toSave));
    } catch (err) {
        console.error('Failed to save exploration state:', err);
    }
}

export function loadExplorationFromStorage(seed) {
    const saved = localStorage.getItem(getStorageKey(seed));
    if (!saved) return null;

    try {
        const parsed = JSON.parse(saved);
        return {
            discovered: new Set(parsed.discovered || []),
            discoveredLinks: new Set(parsed.discoveredLinks || []),
            tags: new Map(Object.entries(parsed.tags || {}))
        };
    } catch (err) {
        console.error('Failed to load exploration state:', err);
        return null;
    }
}

export function clearExplorationStorage(seed) {
    localStorage.removeItem(getStorageKey(seed || state.seed));
}

export function hasExplorationSave(seed) {
    return localStorage.getItem(getStorageKey(seed)) !== null;
}

// ============================================================
// CONSTANTS
// ============================================================

export const START_NODE = 'Chapel of Anticipation';

export const AVAILABLE_TAGS = [
    { id: 'warning', emoji: '⚠️' },
    { id: 'later', emoji: '⏳' },
    { id: 'loot', emoji: '💰' },
    { id: 'done', emoji: '✅' },
    { id: 'star', emoji: '⭐' },
    { id: 'blocked', emoji: '❌' },
    { id: 'key', emoji: '🔑' }
];
