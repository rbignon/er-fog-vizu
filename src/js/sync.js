// ============================================================
// SYNC - WebSocket-based streamer sync (replaces Firebase)
// ============================================================

import * as State from './state.js';

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
const MAX_RECONNECT_ATTEMPTS = 5;
let syncThrottle = null;
let lastSyncedViewport = null;
let isRenderingGraph = false;
let isSyncing = false;

// Check for viewer mode in URL
const urlParams = new URLSearchParams(window.location.search);
const isViewerMode = urlParams.get('viewer') === 'true' || urlParams.get('mode') === 'viewer';
const urlSessionCode = urlParams.get('session');

// =============================================================================
// Initialization
// =============================================================================

export function initFirebase() {
    // Compatibility alias - always returns true since no external service needed
    return true;
}

export function setupViewerMode() {
    if (isViewerMode) {
        document.body.classList.add('viewer-mode');

        if (urlSessionCode) {
            const uploadScreen = document.getElementById('upload-screen');
            if (uploadScreen) {
                uploadScreen.innerHTML = `
                    <div style="text-align: center; color: #c9a227;">
                        <h2 style="font-family: 'Cinzel', serif; margin-bottom: 20px;">Viewer Mode</h2>
                        <p style="color: #9a8d75;">Connecting to session <strong>${urlSessionCode}</strong>...</p>
                        <p style="color: #6a5a4a; font-size: 0.9rem; margin-top: 20px;">Waiting for graph data from host</p>
                    </div>
                `;
            }

            setTimeout(() => joinSession(urlSessionCode), 100);
        }
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
                State.setFirebaseState(true, true, data.code);
                showConnectedUI();
                console.log("Session created:", data.code);
                resolve(data.code);
            }
        };

        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            reject(error);
        };

        ws.onclose = () => {
            console.log("WebSocket closed");
            if (State.isFirebaseConnected()) {
                handleDisconnect();
            }
        };
    });
}

export async function joinSession(code) {
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
                alert(data.message || "Failed to join session");
                ws.close();
                reject(new Error(data.message));
                return;
            }

            if (data.type === 'connected') {
                State.setFirebaseState(true, false, code);
                showConnectedUI();
                if (data.state && Object.keys(data.state).length > 0) {
                    applySessionData(data.state);
                }
                resolve();
            }

            if (data.type === 'state_update') {
                applySessionData(data.state);
            }

            if (data.type === 'host_disconnected') {
                alert("Host has disconnected");
                disconnectSession();
            }
        };

        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            reject(error);
        };

        ws.onclose = () => {
            console.log("WebSocket closed");
            if (State.isFirebaseConnected()) {
                handleDisconnect();
            }
        };
    });
}

function handleDisconnect() {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && State.isFirebaseConnected()) {
        reconnectAttempts++;
        console.log(`Attempting reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
        setTimeout(() => {
            if (State.isStreamerHost()) {
                createSession();
            } else {
                joinSession(State.getSessionCode());
            }
        }, 1000 * reconnectAttempts);
    } else {
        disconnectSession();
    }
}

export function disconnectSession() {
    if (ws) {
        ws.close();
        ws = null;
    }

    State.setFirebaseState(false, false, null);
    lastSyncedViewport = null;
    reconnectAttempts = 0;

    showDisconnectedUI();
}

// =============================================================================
// Sync Logic
// =============================================================================

export function syncToFirebase() {
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

export function syncViewportToFirebase() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !State.isStreamerHost() || isRenderingGraph) return;

    // Viewport sync is handled by the general sync
    syncToFirebase();
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

    // Build nodes state
    const nodesState = {};
    if (graphData && graphData.nodes) {
        graphData.nodes.forEach(n => {
            const pos = nodePositions.get(n.id);
            const nodeEl = nodeElements.filter(d => d.id === n.id);
            const tags = explorationState?.tags?.get(n.id) || [];
            const discovered = explorationState?.discovered?.has(n.id) || false;

            nodesState[n.id] = {
                x: pos ? pos.x : 0,
                y: pos ? pos.y : 0,
                visible: !nodeEl.empty() && nodeEl.style("display") !== "none",
                highlighted: !nodeEl.empty() && nodeEl.classed("highlighted"),
                dimmed: !nodeEl.empty() && nodeEl.classed("dimmed"),
                frontierHighlight: !nodeEl.empty() && nodeEl.classed("frontier-highlight"),
                accessHighlight: !nodeEl.empty() && nodeEl.classed("access-highlight"),
                tagHighlighted: !nodeEl.empty() && nodeEl.classed("tag-highlighted"),
                discovered: discovered,
                tags: tags,
                isBoss: n.isBoss || false,
                scaling: n.scaling || null
            };
        });
    }

    // Build links state
    const linksState = {};
    if (graphData && graphData.links) {
        graphData.links.forEach(l => {
            const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
            const targetId = typeof l.target === 'object' ? l.target.id : l.target;

            const linkEl = linkElements.filter(d => {
                const dSourceId = typeof d.source === 'object' ? d.source.id : d.source;
                const dTargetId = typeof d.target === 'object' ? d.target.id : d.target;
                return dSourceId === sourceId && dTargetId === targetId;
            });

            linksState[`${sourceId}->${targetId}`] = {
                visible: !linkEl.empty() && linkEl.style("display") !== "none",
                highlighted: !linkEl.empty() && linkEl.classed("highlighted"),
                dimmed: !linkEl.empty() && linkEl.classed("dimmed"),
                frontierHighlight: !linkEl.empty() && linkEl.classed("frontier-highlight"),
                type: l.type || null,
                oneWay: l.oneWay || false
            };
        });
    }

    const transform = State.getCurrentZoomTransform();

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
        links: linksState
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

    const nodes = [];
    const explorationState = { discovered: new Set(), tags: new Map() };

    for (const [id, nodeState] of Object.entries(data.nodes)) {
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
    if (data.links) {
        for (const [linkKey, linkState] of Object.entries(data.links)) {
            const [source, target] = linkKey.split('->');
            links.push({
                source: source,
                target: target,
                type: linkState.type || 'fog',
                oneWay: linkState.oneWay || false
            });
        }
    }

    const graphData = { nodes, links, metadata: {} };
    State.setGraphData(graphData);
    State.setExplorationState(explorationState);

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

    // Second pass: apply states to existing simulation nodes
    for (const [id, nodeState] of Object.entries(data.nodes)) {
        const simNode = d3Nodes.find(n => n.id === id);
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

        if (explorationState) {
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
        const nodeState = data.nodes[d.id];
        if (nodeState) {
            const node = d3.select(this);
            node.classed("highlighted", nodeState.highlighted || false)
                .classed("dimmed", nodeState.dimmed || false)
                .classed("frontier-highlight", nodeState.frontierHighlight || false)
                .classed("access-highlight", nodeState.accessHighlight || false)
                .classed("tag-highlighted", nodeState.tagHighlighted || false)
                .classed("viewer-selected", d.id === selectedId);

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

    document.getElementById('session-code-display').textContent = sessionCode;
    document.getElementById('streamer-not-connected').classList.add('hidden');
    document.getElementById('streamer-connected').classList.remove('hidden');
    document.getElementById('streamer-mode-btn').classList.add('connected');

    const viewerUrl = window.location.origin + window.location.pathname +
                     '?viewer=true&session=' + sessionCode;
    document.getElementById('viewer-url-input').value = viewerUrl;

    const syncStatus = document.getElementById('sync-status');
    syncStatus.classList.remove('disconnected');
    syncStatus.querySelector('span:last-child').textContent = State.isStreamerHost() ?
        'Connected as host (controlling)' : 'Connected as viewer (syncing)';
}

function showDisconnectedUI() {
    document.getElementById('streamer-not-connected').classList.remove('hidden');
    document.getElementById('streamer-connected').classList.add('hidden');
    document.getElementById('join-form').classList.add('hidden');
    document.getElementById('streamer-mode-btn').classList.remove('connected');
}

// =============================================================================
// UI Event Listeners
// =============================================================================

export function initStreamerUI() {
    const streamerModal = document.getElementById('streamer-modal');
    if (!streamerModal) {
        setTimeout(initStreamerUI, 50);
        return;
    }

    const streamerModeBtn = document.getElementById('streamer-mode-btn');
    if (streamerModeBtn) {
        streamerModeBtn.addEventListener('click', () => {
            streamerModal.classList.add('visible');
        });
    }

    const closeModalBtn = document.getElementById('close-streamer-modal');
    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', () => {
            streamerModal.classList.remove('visible');
        });
    }

    const createSessionBtn = document.getElementById('create-session-btn');
    if (createSessionBtn) {
        createSessionBtn.addEventListener('click', createSession);
    }

    const joinSessionBtn = document.getElementById('join-session-btn');
    if (joinSessionBtn) {
        joinSessionBtn.addEventListener('click', () => {
            document.getElementById('join-form').classList.remove('hidden');
            document.getElementById('join-code-input').focus();
        });
    }

    const joinCancelBtn = document.getElementById('join-cancel-btn');
    if (joinCancelBtn) {
        joinCancelBtn.addEventListener('click', () => {
            document.getElementById('join-form').classList.add('hidden');
        });
    }

    const joinConfirmBtn = document.getElementById('join-confirm-btn');
    if (joinConfirmBtn) {
        joinConfirmBtn.addEventListener('click', () => {
            const code = document.getElementById('join-code-input').value;
            if (code.length >= 4) joinSession(code);
        });
    }

    const joinCodeInput = document.getElementById('join-code-input');
    if (joinCodeInput) {
        joinCodeInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && e.target.value.length >= 4) {
                joinSession(e.target.value);
            }
        });
    }

    const disconnectBtn = document.getElementById('disconnect-btn');
    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', disconnectSession);
    }

    const copyUrlBtn = document.getElementById('copy-url-btn');
    if (copyUrlBtn) {
        copyUrlBtn.addEventListener('click', () => {
            const urlInput = document.getElementById('viewer-url-input');
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

    streamerModal.addEventListener('click', (e) => {
        if (e.target.id === 'streamer-modal') {
            streamerModal.classList.remove('visible');
        }
    });
}

// =============================================================================
// State Event Subscriptions
// =============================================================================

State.subscribe('nodePositionsSaved', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        syncToFirebase();
    }
});

State.subscribe('viewportChanged', () => {
    syncViewportToFirebase();
});

State.subscribe('selectionChanged', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        setTimeout(() => syncToFirebase(), 50);
    }
});

State.subscribe('nodeDiscovered', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        syncToFirebase();
    }
});

State.subscribe('nodeUndiscovered', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        syncToFirebase();
    }
});

State.subscribe('nodeTagsChanged', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        syncToFirebase();
    }
});

State.subscribe('nodeSelected', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        setTimeout(() => syncToFirebase(), 50);
    }
});

State.subscribe('searchMatched', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        setTimeout(() => syncToFirebase(), 50);
    }
});

State.subscribe('searchCleared', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        setTimeout(() => syncToFirebase(), 50);
    }
});

State.subscribe('frontierHighlightChanged', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        setTimeout(() => syncToFirebase(), 50);
    }
});

State.subscribe('tagFilterChanged', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        setTimeout(() => syncToFirebase(), 50);
    }
});

State.subscribe('explorationModeChanged', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        setTimeout(() => syncToFirebase(), 200);
    }
});

State.subscribe('graphRenderCompleted', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        syncToFirebase();
    }
});
