// ============================================================
// STATE - Centralized application state with event bus
// ============================================================

// Application state (single source of truth)
const state = {
    // Graph data
    graphData: null,
    seed: null,
    
    // Item log (optional)
    itemLogData: null,
    
    // Exploration mode
    explorationMode: true,  // true = Explorer, false = Full Spoiler
    explorationState: {
        discovered: new Set(['Chapel of Anticipation']),  // Start with starting area discovered
        tags: new Map()
    },
    frontierHighlightActive: false,
    
    // Graph visualization state
    nodePositions: new Map(),
    currentZoomTransform: null,
    selectedNodeId: null,
    pendingSelectionRealId: null,  // Used to find placeholder after undiscover
    simulation: null,
    
    // Sync state
    syncConnected: false,
    isStreamerHost: false,
    sessionCode: null
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

export function getItemLogData() {
    return state.itemLogData;
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

export function setItemLogData(data) {
    state.itemLogData = data;
    emit('itemLogDataChanged', data);
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

export function getPendingSelectionRealId() {
    return state.pendingSelectionRealId;
}

export function setPendingSelectionRealId(realId) {
    state.pendingSelectionRealId = realId;
}

export function clearPendingSelectionRealId() {
    state.pendingSelectionRealId = null;
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
