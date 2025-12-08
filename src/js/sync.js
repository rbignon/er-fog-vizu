// ============================================================
// SYNC - WebSocket-based streamer sync
// ============================================================

import * as State from './state.js';
import * as Toast from './toast.js';

// =============================================================================
// Configuration
// =============================================================================

// WebSocket server URL - same host as page
function getWsUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
}

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DURATION = 5 * 60 * 1000;  // 5 minutes total
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;  // Cap at 30 seconds between attempts
let reconnectStartTime = null;
let isReconnecting = false;
let syncThrottle = null;
let lastSyncedViewport = null;
let isRenderingGraph = false;
let isSyncing = false;
let currentSessionCode = null;  // Track session code for reconnection

// Check for viewer mode in URL
const urlParams = new URLSearchParams(window.location.search);
const isViewerMode = urlParams.get('viewer') === 'true' || urlParams.get('mode') === 'viewer';
const urlSessionCode = urlParams.get('session');

// =============================================================================
// Initialization
// =============================================================================

export function initSync() {
    // No-op - WebSocket connections are created on demand
    return true;
}

export function setupViewerMode() {
    if (isViewerMode) {
        document.body.classList.add('viewer-mode');

        if (urlSessionCode) {
            const uploadScreen = document.getElementById('upload-screen');
            if (uploadScreen) {
                uploadScreen.innerHTML = `
                    <div id="viewer-status">
                        <h2>Viewer Mode</h2>
                        <p class="viewer-status-session">Session <strong>${urlSessionCode}</strong></p>
                        <p class="viewer-status-message">Connecting...</p>
                    </div>
                `;
            }

            setTimeout(() => joinSession(urlSessionCode), 100);
        }
    }
}

function updateViewerStatus(message, isError = false) {
    const statusMessage = document.querySelector('.viewer-status-message');
    if (statusMessage) {
        statusMessage.textContent = message;
        statusMessage.classList.toggle('error', isError);
    }
}

// =============================================================================
// Session Management
// =============================================================================

export async function createSession() {
    return new Promise((resolve, reject) => {
        const wsUrl = getWsUrl();
        ws = new WebSocket(`${wsUrl}/ws/host`);

        ws.onopen = () => {
            console.log("WebSocket connected as host");
            reconnectAttempts = 0;
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'session_created') {
                currentSessionCode = data.code;
                State.setSyncState(true, true, data.code);
                showConnectedUI();
                console.log("Session created:", data.code);
                resolve(data.code);
            }
        };

        ws.onerror = () => {
            reject(new Error("Connection failed"));
        };

        ws.onclose = () => {
            if (State.isSyncConnected()) {
                handleDisconnect();
            }
        };
    });
}

async function resumeHostSession(code) {
    return new Promise((resolve, reject) => {
        const wsUrl = getWsUrl();
        ws = new WebSocket(`${wsUrl}/ws/host/${code}`);

        ws.onopen = () => {
            console.log("WebSocket reconnecting as host...");
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'error') {
                console.log("Failed to resume session:", data.message);
                ws.close();
                reject(new Error(data.message));
                return;
            }

            if (data.type === 'session_resumed') {
                reconnectAttempts = 0;
                currentSessionCode = data.code;
                State.setSyncState(true, true, data.code);
                showConnectedUI();
                updateSyncStatus("Reconnected");
                console.log("Session resumed:", data.code);
                // Send current state immediately after resume
                setTimeout(() => syncState(), 100);
                resolve(data.code);
            }
        };

        ws.onerror = () => {
            reject(new Error("Connection failed"));
        };

        ws.onclose = () => {
            if (State.isSyncConnected()) {
                handleDisconnect();
            }
        };
    });
}

export async function joinSession(code, isReconnect = false) {
    code = code.toUpperCase().trim();

    return new Promise((resolve, reject) => {
        const wsUrl = getWsUrl();
        ws = new WebSocket(`${wsUrl}/ws/viewer/${code}`);

        ws.onopen = () => {
            console.log("WebSocket connected as viewer");
            reconnectAttempts = 0;
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'error') {
                if (!isReconnect) {
                    if (isViewerMode) {
                        updateViewerStatus(data.message || "Failed to join session", true);
                    } else {
                        Toast.error(data.message || "Failed to join session");
                    }
                    ws.close();
                    reject(new Error(data.message));
                } else {
                    // During reconnect, treat "session not found" as temporary
                    // (host might not have reconnected yet after server restart)
                    console.log("Session not found during reconnect, will retry...");
                    ws.close();
                    reject(new Error(data.message));
                }
                return;
            }

            if (data.type === 'connected') {
                currentSessionCode = code;
                State.setSyncState(true, false, code);
                showConnectedUI();
                if (isReconnect) {
                    const msg = data.host_connected ? "Reconnected" : "Reconnected (host offline)";
                    if (isViewerMode) {
                        updateViewerStatus(msg);
                    } else {
                        updateSyncStatus(msg);
                    }
                }
                if (data.state && Object.keys(data.state).length > 0) {
                    applySessionData(data.state);
                }
                resolve();
            }

            if (data.type === 'state_update') {
                applySessionData(data.state);
            }

            if (data.type === 'host_disconnected') {
                if (isViewerMode) {
                    updateViewerStatus("Host disconnected - waiting...");
                } else {
                    updateSyncStatus("Host disconnected - waiting...");
                }
            }

            if (data.type === 'host_reconnected') {
                if (isViewerMode) {
                    updateViewerStatus("Host reconnected");
                } else {
                    updateSyncStatus("Host reconnected");
                }
            }

            if (data.type === 'session_expired') {
                if (isViewerMode) {
                    updateViewerStatus("Session has expired", true);
                } else {
                    Toast.warning("Session has expired");
                }
                disconnectSession();
            }
        };

        ws.onerror = () => {
            reject(new Error("Connection failed"));
        };

        ws.onclose = () => {
            if (State.isSyncConnected()) {
                handleDisconnect();
            }
        };
    });
}

async function handleDisconnect() {
    // Prevent multiple concurrent reconnection attempts
    if (isReconnecting) {
        return;
    }

    const sessionCode = currentSessionCode;
    if (!State.isSyncConnected() || !sessionCode) {
        return;
    }

    // Initialize reconnection timer on first attempt
    if (reconnectStartTime === null) {
        reconnectStartTime = Date.now();
    }

    // Check if we've exceeded the max reconnection duration
    const elapsed = Date.now() - reconnectStartTime;
    if (elapsed >= MAX_RECONNECT_DURATION) {
        console.log("Max reconnect duration reached (5 minutes)");
        reconnectStartTime = null;
        reconnectAttempts = 0;
        disconnectSession();
        return;
    }

    reconnectAttempts++;
    // Exponential backoff with cap
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_DELAY);
    const remainingTime = Math.round((MAX_RECONNECT_DURATION - elapsed) / 1000);
    console.log(`Attempting reconnect ${reconnectAttempts} in ${delay}ms (${remainingTime}s remaining)...`);
    const reconnectMsg = `Reconnecting... (${remainingTime}s remaining)`;
    if (isViewerMode) {
        updateViewerStatus(reconnectMsg);
    } else {
        updateSyncStatus(reconnectMsg);
    }

    isReconnecting = true;

    setTimeout(async () => {
        // Check again if we should still reconnect
        if (!State.isSyncConnected() || currentSessionCode !== sessionCode) {
            isReconnecting = false;
            return;
        }

        try {
            if (State.isStreamerHost()) {
                await resumeHostSession(sessionCode);
            } else {
                await joinSession(sessionCode, true);
            }
            // Success - reset counters
            reconnectStartTime = null;
            reconnectAttempts = 0;
        } catch {
            // Schedule next attempt
            isReconnecting = false;
            handleDisconnect();
            return;
        }
        isReconnecting = false;
    }, delay);
}

export function disconnectSession() {
    // Reset reconnection state first to prevent further attempts
    isReconnecting = false;
    reconnectStartTime = null;
    reconnectAttempts = 0;
    currentSessionCode = null;

    if (ws) {
        ws.close();
        ws = null;
    }

    State.setSyncState(false, false, null);
    lastSyncedViewport = null;

    showDisconnectedUI();
}

// =============================================================================
// Sync Logic
// =============================================================================

export function syncState() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !State.isStreamerHost() || isSyncing) return;

    // Throttle syncs to avoid flooding
    if (syncThrottle) return;

    syncThrottle = setTimeout(() => {
        syncThrottle = null;

        isSyncing = true;
        try {
            ws.send(JSON.stringify({
                type: 'state_update',
                state: getFullSyncState()
            }));
        } finally {
            isSyncing = false;
        }
    }, 50);
}

export function syncViewport() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !State.isStreamerHost() || isRenderingGraph) return;

    // Viewport sync is handled by the general sync
    syncState();
}

// =============================================================================
// State Serialization
// =============================================================================

function getFullSyncState() {
    const simulation = State.getSimulation();
    if (simulation) {
        simulation.nodes().forEach(node => {
            if (node.x !== undefined && node.y !== undefined) {
                State.saveNodePosition(node.id, node.x, node.y);
            }
        });
    }

    const nodeElements = d3.selectAll(".node");
    const linkElements = d3.selectAll(".link");

    const graphData = State.getGraphData();
    const nodePositions = State.getNodePositions();
    const explorationState = State.getExplorationState();

    // Build nodes state from DOM (includes placeholders)
    const nodesState = {};
    nodeElements.each(function(d) {
        const nodeEl = d3.select(this);
        const pos = nodePositions.get(d.id);

        // For placeholders, get position from simulation data
        const x = d.x !== undefined ? d.x : (pos ? pos.x : 0);
        const y = d.y !== undefined ? d.y : (pos ? pos.y : 0);

        const tags = explorationState?.tags?.get(d.id) || [];
        const discovered = d.isPlaceholder ? false : (explorationState?.discovered?.has(d.id) || false);

        nodesState[d.id] = {
            x: x,
            y: y,
            visible: nodeEl.style("display") !== "none",
            highlighted: nodeEl.classed("highlighted"),
            dimmed: nodeEl.classed("dimmed"),
            frontierHighlight: nodeEl.classed("frontier-highlight"),
            accessHighlight: nodeEl.classed("access-highlight"),
            tagHighlighted: nodeEl.classed("tag-highlighted"),
            discovered: discovered,
            tags: tags,
            isBoss: d.isBoss || false,
            scaling: d.scaling || null,
            isPlaceholder: d.isPlaceholder || false,
            realId: d.realId || null,
            sourceNodeId: d.sourceNodeId || null
        };
    });

    // Build links state from DOM (includes links to placeholders)
    const linksState = {};
    linkElements.each(function(d) {
        const linkEl = d3.select(this);
        const sourceId = typeof d.source === 'object' ? d.source.id : d.source;
        const targetId = typeof d.target === 'object' ? d.target.id : d.target;

        linksState[`${sourceId}->${targetId}`] = {
            visible: linkEl.style("display") !== "none",
            highlighted: linkEl.classed("highlighted"),
            dimmed: linkEl.classed("dimmed"),
            frontierHighlight: linkEl.classed("frontier-highlight"),
            type: d.type || null,
            oneWay: d.oneWay || false,
            // Store original target for placeholder links
            originalTarget: d.originalTarget || null,
            originalSource: d.originalSource || null
        };
    });

    // Also include original graph nodes (undiscovered ones) for viewer to rebuild
    if (graphData && graphData.nodes) {
        graphData.nodes.forEach(n => {
            if (!nodesState[n.id]) {
                nodesState[n.id] = {
                    x: 0,
                    y: 0,
                    visible: false,
                    highlighted: false,
                    dimmed: false,
                    frontierHighlight: false,
                    accessHighlight: false,
                    tagHighlighted: false,
                    discovered: false,
                    tags: [],
                    isBoss: n.isBoss || false,
                    scaling: n.scaling || null,
                    isPlaceholder: false,
                    isOriginalNode: true
                };
            }
        });
    }

    // Also include original graph links for viewer to rebuild the graph
    if (graphData && graphData.links) {
        graphData.links.forEach(l => {
            const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
            const targetId = typeof l.target === 'object' ? l.target.id : l.target;
            const key = `${sourceId}->${targetId}`;
            // Only add if not already present (don't overwrite visual state)
            if (!linksState[key]) {
                linksState[key] = {
                    visible: false,
                    highlighted: false,
                    dimmed: false,
                    frontierHighlight: false,
                    type: l.type || null,
                    oneWay: l.oneWay || false,
                    isOriginalLink: true
                };
            }
        });
    }

    const transform = State.getCurrentZoomTransform();

    // Include discovered links for proper link visibility on viewer
    const discoveredLinks = explorationState?.discoveredLinks
        ? Array.from(explorationState.discoveredLinks)
        : [];

    return {
        created: Date.now(),
        explorationMode: State.isExplorationMode(),
        viewport: {
            x: transform?.x || 0,
            y: transform?.y || 0,
            k: transform?.k || 1,
            hostWidth: window.innerWidth,
            hostHeight: window.innerHeight
        },
        selectedNodeId: State.getSelectedNodeId() || null,
        frontierHighlightActive: State.isFrontierHighlightActive(),
        nodes: nodesState,
        links: linksState,
        discoveredLinks: discoveredLinks
    };
}

// =============================================================================
// State Application (viewer side)
// =============================================================================

function applySessionData(data) {
    if (!data) return;

    const hasNodes = data.nodes && Object.keys(data.nodes).length > 0;

    const currentGraphData = State.getGraphData();
    if (hasNodes && !currentGraphData) {
        buildGraphFromSessionData(data);
        return;
    }

    const rerendering = applyVisualState(data);

    if (data.viewport && !State.isStreamerHost() && !rerendering) {
        applyViewport(data.viewport);
    }
}

function buildGraphFromSessionData(data) {
    console.log("Building graph from session data...");

    // Set exploration mode FIRST so renderGraph creates placeholders correctly
    if (data.explorationMode !== undefined) {
        State.setExplorationMode(data.explorationMode);
    }

    const nodes = [];
    const explorationState = { discovered: new Set(), discoveredLinks: new Set(), tags: new Map() };

    for (const [id, nodeState] of Object.entries(data.nodes)) {
        // Skip placeholder nodes - they will be recreated by renderGraph
        if (nodeState.isPlaceholder) {
            continue;
        }

        nodes.push({
            id: id,
            isBoss: nodeState.isBoss || false,
            scaling: nodeState.scaling || null,
            x: nodeState.x,
            y: nodeState.y
        });

        if (nodeState.x !== undefined && nodeState.y !== undefined) {
            State.saveNodePosition(id, nodeState.x, nodeState.y);
        }

        if (nodeState.discovered) explorationState.discovered.add(id);
        if (nodeState.tags && nodeState.tags.length > 0) {
            explorationState.tags.set(id, nodeState.tags);
        }
    }

    const links = [];
    const seenLinks = new Set();
    if (data.links) {
        for (const [linkKey, linkState] of Object.entries(data.links)) {
            const [source, target] = linkKey.split('->');

            // Skip links involving placeholders - they will be recreated by renderGraph
            if (source.startsWith('???_') || target.startsWith('???_')) {
                continue;
            }

            // Avoid duplicates
            if (seenLinks.has(linkKey)) continue;
            seenLinks.add(linkKey);

            links.push({
                source: source,
                target: target,
                type: linkState.type || 'fog',
                oneWay: linkState.oneWay || false
            });
        }
    }

    // Restore discovered links from sync data
    if (data.discoveredLinks && Array.isArray(data.discoveredLinks)) {
        data.discoveredLinks.forEach(linkId => {
            explorationState.discoveredLinks.add(linkId);
        });
    }

    const graphData = { nodes, links, metadata: {} };
    State.setGraphData(graphData);
    State.setExplorationState(explorationState);

    // Set frontier highlight state so it persists
    if (data.frontierHighlightActive !== undefined) {
        State.setFrontierHighlightActive(data.frontierHighlightActive);
    }

    const uploadScreen = document.getElementById('upload-screen');
    if (uploadScreen) {
        uploadScreen.classList.add('hidden');
    }
    const mainUI = document.getElementById('main-ui');
    if (mainUI) {
        mainUI.classList.add('visible');
    }

    State.emit('graphNeedsRender', { preservePositions: true });

    setTimeout(() => {
        applyVisualState(data);
        if (data.viewport) applyViewport(data.viewport);
    }, 500);
}

function applyViewport(vp) {
    if (!vp || vp.x === undefined || isRenderingGraph) return;

    const svg = d3.select("svg");
    const g = svg.select("g");

    if (!svg.node() || !g.node()) {
        setTimeout(() => applyViewport(vp), 200);
        return;
    }

    if (lastSyncedViewport &&
        Math.abs(vp.x - lastSyncedViewport.x) <= 1 &&
        Math.abs(vp.y - lastSyncedViewport.y) <= 1 &&
        Math.abs(vp.k - lastSyncedViewport.k) <= 0.01) {
        return;
    }

    lastSyncedViewport = { x: vp.x, y: vp.y, k: vp.k };

    if (!vp || typeof vp.x !== 'number' || typeof vp.y !== 'number' || typeof vp.k !== 'number' ||
        isNaN(vp.x) || isNaN(vp.y) || isNaN(vp.k) || !isFinite(vp.x) || !isFinite(vp.y) || !isFinite(vp.k) || vp.k <= 0) {
        console.warn("Invalid viewport data:", vp);
        return;
    }

    const viewerWidth = window.innerWidth;
    const viewerHeight = window.innerHeight;
    const hostWidth = vp.hostWidth || viewerWidth;
    const hostHeight = vp.hostHeight || viewerHeight;

    const hostCenterX = (hostWidth / 2 - vp.x) / vp.k;
    const hostCenterY = (hostHeight / 2 - vp.y) / vp.k;
    const x = viewerWidth / 2 - hostCenterX * vp.k;
    const y = viewerHeight / 2 - hostCenterY * vp.k;

    if (isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y) || !isFinite(vp.k) || vp.k <= 0) {
        console.warn("Invalid calculated viewport transform:", { x, y, vp });
        return;
    }

    const transform = d3.zoomIdentity.translate(x, y).scale(vp.k);
    State.setCurrentZoomTransform(transform);

    g.transition()
        .duration(300)
        .attr("transform", `translate(${x},${y}) scale(${vp.k})`);
}

function applyVisualState(data) {
    if (!data.nodes) return false;

    if (data.explorationMode !== undefined) {
        const currentMode = State.isExplorationMode();
        if (data.explorationMode !== currentMode) {
            State.setExplorationMode(data.explorationMode);
            isRenderingGraph = true;
            State.saveAllNodePositions();
            State.emit('graphNeedsRender', { preservePositions: true });
            setTimeout(() => {
                isRenderingGraph = false;
                applyVisualClasses(data);
                if (data.viewport) applyViewport(data.viewport);
            }, 200);
            return true;
        }
    }

    const simulation = State.getSimulation();
    const d3Nodes = simulation ? simulation.nodes() : [];
    let positionsChanged = false;
    let explorationChanged = false;

    const explorationState = State.getExplorationState();

    // First pass: save ALL node positions
    for (const [id, nodeState] of Object.entries(data.nodes)) {
        if (nodeState.x !== undefined && nodeState.y !== undefined &&
            !isNaN(nodeState.x) && !isNaN(nodeState.y) && isFinite(nodeState.x) && isFinite(nodeState.y)) {
            State.saveNodePosition(id, nodeState.x, nodeState.y);
        }
    }

    // Second pass: apply states to existing simulation nodes and detect missing nodes
    let hasMissingNodes = false;
    for (const [id, nodeState] of Object.entries(data.nodes)) {
        const simNode = d3Nodes.find(n => n.id === id);

        // Check if this node exists in the viewer's DOM
        if (!simNode && (nodeState.highlighted || nodeState.frontierHighlight || id === data.selectedNodeId)) {
            // A highlighted node doesn't exist in viewer - need to re-render
            hasMissingNodes = true;
        }

        if (simNode && nodeState.x !== undefined && nodeState.y !== undefined &&
            !isNaN(nodeState.x) && !isNaN(nodeState.y) && isFinite(nodeState.x) && isFinite(nodeState.y)) {
            if (Math.abs(simNode.x - nodeState.x) > 1 || Math.abs(simNode.y - nodeState.y) > 1) {
                simNode.x = nodeState.x;
                simNode.y = nodeState.y;
                simNode.fx = nodeState.x;
                simNode.fy = nodeState.y;
                positionsChanged = true;
            }
        }

        if (explorationState && !nodeState.isPlaceholder) {
            const wasDiscovered = explorationState.discovered.has(id);
            const isDiscovered = nodeState.discovered || false;
            if (wasDiscovered !== isDiscovered) {
                explorationChanged = true;
                if (isDiscovered) {
                    explorationState.discovered.add(id);
                } else {
                    explorationState.discovered.delete(id);
                }
            }

            const oldTags = explorationState.tags.get(id) || [];
            const newTags = nodeState.tags || [];
            if (JSON.stringify(oldTags) !== JSON.stringify(newTags)) {
                explorationChanged = true;
                if (newTags.length > 0) {
                    explorationState.tags.set(id, newTags);
                } else {
                    explorationState.tags.delete(id);
                }
            }
        }
    }

    // Sync discovered links
    if (data.discoveredLinks && Array.isArray(data.discoveredLinks) && explorationState) {
        const newDiscoveredLinks = new Set(data.discoveredLinks);
        const currentLinks = explorationState.discoveredLinks || new Set();

        // Check if links changed
        if (newDiscoveredLinks.size !== currentLinks.size ||
            [...newDiscoveredLinks].some(l => !currentLinks.has(l))) {
            explorationChanged = true;
            explorationState.discoveredLinks = newDiscoveredLinks;
        }
    }

    // If we have missing highlighted nodes, force a re-render
    if (hasMissingNodes && !explorationChanged) {
        explorationChanged = true;
    }

    if (explorationChanged) {
        isRenderingGraph = true;
        State.saveAllNodePositions();

        State.emit('graphNeedsRender', { preservePositions: true });
        setTimeout(() => {
            isRenderingGraph = false;
            applyVisualClasses(data);
        }, 500);
        return true;
    }

    if (data.frontierHighlightActive !== undefined) {
        const currentFrontierActive = State.isFrontierHighlightActive();
        if (data.frontierHighlightActive !== currentFrontierActive) {
            updateFrontierCheckboxState(data.frontierHighlightActive);
        }
    }

    applyVisualClasses(data);

    if (positionsChanged) {
        updatePositionsInDOM(d3Nodes);
    }

    if (data.selectedNodeId !== undefined) {
        State.setSelectedNodeId(data.selectedNodeId || null);
    }

    return false;
}

function updateFrontierCheckboxState(active) {
    const frontierCheckbox = document.getElementById('show-frontier-checkbox');
    if (frontierCheckbox) {
        frontierCheckbox.checked = active;
    }
}

function applyVisualClasses(data) {
    const selectedId = data.selectedNodeId || null;

    d3.selectAll(".node").each(function(d) {
        const nodeState = data.nodes?.[d.id];
        const node = d3.select(this);

        if (nodeState) {
            node.classed("highlighted", nodeState.highlighted || false)
                .classed("dimmed", nodeState.dimmed || false)
                .classed("frontier-highlight", nodeState.frontierHighlight || false)
                .classed("access-highlight", nodeState.accessHighlight || false)
                .classed("tag-highlighted", nodeState.tagHighlighted || false);
        }

        // Handle selection separately - apply even if nodeState doesn't exist
        node.classed("viewer-selected", d.id === selectedId);

        if (d.id === selectedId && isViewerMode) {
            if (node.select(".selection-ring").empty()) {
                const circle = node.select("circle");
                const r = parseFloat(circle.attr("r")) || 7;
                node.insert("circle", "circle")
                    .attr("class", "selection-ring")
                    .attr("r", r + 8);
            }
        } else {
            node.select(".selection-ring").remove();
        }
    });

    if (data.links) {
        d3.selectAll(".link").each(function(d) {
            const sourceId = typeof d.source === 'object' ? d.source.id : d.source;
            const targetId = typeof d.target === 'object' ? d.target.id : d.target;
            const linkKey = `${sourceId}->${targetId}`;
            const linkState = data.links[linkKey];
            if (linkState) {
                d3.select(this)
                    .classed("highlighted", linkState.highlighted || false)
                    .classed("dimmed", linkState.dimmed || false)
                    .classed("frontier-highlight", linkState.frontierHighlight || false);
            }
        });
    }
}

function updatePositionsInDOM(d3Nodes) {
    d3.selectAll(".node")
        .transition()
        .duration(300)
        .attr("transform", d => {
            const x = (typeof d.x === 'number' && !isNaN(d.x) && isFinite(d.x)) ? d.x : 0;
            const y = (typeof d.y === 'number' && !isNaN(d.y) && isFinite(d.y)) ? d.y : 0;
            return `translate(${x},${y})`;
        });

    d3.selectAll(".link")
        .transition()
        .duration(300)
        .attr("d", d => {
            const sourceX = (typeof d.source.x === 'number' && !isNaN(d.source.x)) ? d.source.x : 0;
            const sourceY = (typeof d.source.y === 'number' && !isNaN(d.source.y)) ? d.source.y : 0;
            const targetX = (typeof d.target.x === 'number' && !isNaN(d.target.x)) ? d.target.x : 0;
            const targetY = (typeof d.target.y === 'number' && !isNaN(d.target.y)) ? d.target.y : 0;
            const dx = targetX - sourceX;
            const dy = targetY - sourceY;
            const dr = Math.sqrt(dx * dx + dy * dy) * 2;
            return `M${sourceX},${sourceY}A${dr},${dr} 0 0,1 ${targetX},${targetY}`;
        });

    setTimeout(() => {
        d3Nodes.forEach(n => {
            if (typeof n.x === 'number' && typeof n.y === 'number' && !isNaN(n.x) && !isNaN(n.y)) {
                n.fx = null;
                n.fy = null;
            }
        });
    }, 500);
}

// =============================================================================
// UI Functions
// =============================================================================

function showConnectedUI() {
    const sessionCode = State.getSessionCode();

    document.getElementById('stream-not-connected').classList.add('hidden');
    document.getElementById('stream-connected').classList.remove('hidden');

    const streamBtn = document.getElementById('stream-btn');
    if (streamBtn) {
        streamBtn.classList.add('active');
    }

    const viewerUrl = window.location.origin + window.location.pathname +
                     '?viewer=true&session=' + sessionCode;
    document.getElementById('stream-url-input').value = viewerUrl;

    const syncStatus = document.getElementById('sync-status');
    syncStatus.classList.remove('disconnected');
    syncStatus.querySelector('span:last-child').textContent = 'Session active';
}

function updateSyncStatus(message) {
    const syncStatus = document.getElementById('sync-status');
    if (syncStatus) {
        const textSpan = syncStatus.querySelector('span:last-child');
        if (textSpan) {
            textSpan.textContent = message;
        }
    }
}

function showDisconnectedUI() {
    document.getElementById('stream-not-connected').classList.remove('hidden');
    document.getElementById('stream-connected').classList.add('hidden');

    const streamBtn = document.getElementById('stream-btn');
    if (streamBtn) {
        streamBtn.classList.remove('active');
    }
}

// =============================================================================
// UI Event Listeners
// =============================================================================

export function initStreamUI() {
    const streamModal = document.getElementById('stream-modal');
    if (!streamModal) {
        setTimeout(initStreamUI, 50);
        return;
    }

    const streamBtn = document.getElementById('stream-btn');
    if (streamBtn) {
        streamBtn.addEventListener('click', () => {
            streamModal.classList.add('visible');
        });
    }

    // All close buttons
    const closeModal = () => streamModal.classList.remove('visible');

    document.getElementById('close-stream-modal')?.addEventListener('click', closeModal);
    document.getElementById('close-not-connected-btn')?.addEventListener('click', closeModal);
    document.getElementById('close-connected-btn')?.addEventListener('click', closeModal);

    const startSessionBtn = document.getElementById('start-session-btn');
    if (startSessionBtn) {
        startSessionBtn.addEventListener('click', createSession);
    }

    const endSessionBtn = document.getElementById('end-session-btn');
    if (endSessionBtn) {
        endSessionBtn.addEventListener('click', disconnectSession);
    }

    const copyUrlBtn = document.getElementById('copy-url-btn');
    if (copyUrlBtn) {
        copyUrlBtn.addEventListener('click', () => {
            const urlInput = document.getElementById('stream-url-input');
            if (urlInput) {
                urlInput.select();
                navigator.clipboard.writeText(urlInput.value).then(() => {
                    const originalText = copyUrlBtn.textContent;
                    copyUrlBtn.textContent = 'Copied!';
                    setTimeout(() => { copyUrlBtn.textContent = originalText; }, 2000);
                });
            }
        });
    }

    streamModal.addEventListener('click', (e) => {
        if (e.target.id === 'stream-modal') {
            streamModal.classList.remove('visible');
        }
    });
}

// =============================================================================
// State Event Subscriptions
// =============================================================================

State.subscribe('nodePositionsSaved', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        syncState();
    }
});

State.subscribe('viewportChanged', () => {
    syncViewport();
});

State.subscribe('selectionChanged', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        setTimeout(() => syncState(), 50);
    }
});

State.subscribe('nodeDiscovered', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        syncState();
    }
});

State.subscribe('nodeUndiscovered', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        syncState();
    }
});

State.subscribe('nodeTagsChanged', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        syncState();
    }
});

State.subscribe('nodeSelected', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        setTimeout(() => syncState(), 50);
    }
});

State.subscribe('searchMatched', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        setTimeout(() => syncState(), 50);
    }
});

State.subscribe('searchCleared', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        setTimeout(() => syncState(), 50);
    }
});

State.subscribe('frontierHighlightChanged', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        setTimeout(() => syncState(), 50);
    }
});

State.subscribe('tagFilterChanged', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        setTimeout(() => syncState(), 50);
    }
});

State.subscribe('explorationModeChanged', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        setTimeout(() => syncState(), 200);
    }
});

State.subscribe('graphRenderCompleted', () => {
    if (State.isSyncConnected() && State.isStreamerHost()) {
        syncState();
    }
});
