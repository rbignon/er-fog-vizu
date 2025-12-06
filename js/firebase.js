// ============================================================
// FIREBASE - Streamer sync and OBS viewer
// ============================================================

import * as State from './state.js';

// ============================================================
// FIREBASE CONFIG
// ============================================================

const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCVsW7f5oMCStDgwHSOcafYwfr8o-O7vd0",
    authDomain: "er-fog-sync.firebaseapp.com",
    databaseURL: "https://er-fog-sync-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "er-fog-sync",
    storageBucket: "er-fog-sync.firebasestorage.app",
    messagingSenderId: "357546558960",
    appId: "1:357546558960:web:ef5b9f87154ecded060935"
};

let firebaseApp = null;
let firebaseDb = null;
let sessionRef = null;
let viewportSyncThrottle = null;
let lastSyncedViewport = null;
let isRenderingGraph = false;
let viewerUpdateThrottle = null;
let pendingViewerData = null;
let isSyncing = false; // Prevent recursive sync

// Check for viewer mode in URL
const urlParams = new URLSearchParams(window.location.search);
const isViewerMode = urlParams.get('viewer') === 'true' || urlParams.get('mode') === 'viewer';
const urlSessionCode = urlParams.get('session');

// ============================================================
// INITIALIZATION
// ============================================================

export function initFirebase() {
    if (firebaseApp) return true;
    
    try {
        if (FIREBASE_CONFIG.apiKey === "AIzaSyplaceholder") {
            console.warn("Firebase not configured. Streamer sync disabled.");
            return false;
        }
        
        firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
        firebaseDb = firebase.database();
        return true;
    } catch (error) {
        console.error("Firebase initialization failed:", error);
        return false;
    }
}

export function setupViewerMode() {
    if (isViewerMode) {
        document.body.classList.add('viewer-mode');
        
        if (urlSessionCode) {
            const uploadScreen = document.getElementById('upload-screen');
            if (uploadScreen) {
                uploadScreen.innerHTML = `
                    <div style="text-align: center; color: #c9a227;">
                        <h2 style="font-family: 'Cinzel', serif; margin-bottom: 20px;">🎬 Viewer Mode</h2>
                        <p style="color: #9a8d75;">Connecting to session <strong>${urlSessionCode}</strong>...</p>
                        <p style="color: #6a5a4a; font-size: 0.9rem; margin-top: 20px;">Waiting for graph data from host</p>
                    </div>
                `;
            }
            
            // Auto-join session after a short delay
            setTimeout(() => joinSession(urlSessionCode), 100);
        }
    }
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

function generateSessionCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

export async function createSession() {
    if (!initFirebase()) {
        alert("Firebase is not configured. Please set up Firebase credentials.");
        return;
    }
    
    const sessionCode = generateSessionCode();
    State.setFirebaseState(true, true, sessionCode);
    
    sessionRef = firebaseDb.ref('sessions/' + sessionCode);
    await sessionRef.set(getFullSyncState());
    
    listenToSession();
    showConnectedUI();
    
    console.log("Session created:", sessionCode);
}

export async function joinSession(code) {
    if (!initFirebase()) {
        alert("Firebase is not configured.");
        return;
    }
    
    code = code.toUpperCase().trim();
    
    const snapshot = await firebaseDb.ref('sessions/' + code).once('value');
    if (!snapshot.exists()) {
        alert("Session not found. Please check the code and try again.");
        return;
    }
    
    State.setFirebaseState(true, false, code);
    sessionRef = firebaseDb.ref('sessions/' + code);
    
    const data = snapshot.val();
    applySessionData(data);
    
    listenToSession();
    showConnectedUI();
}

export function disconnectSession() {
    if (sessionRef) {
        sessionRef.off();
    }
    
    State.setFirebaseState(false, false, null);
    sessionRef = null;
    lastSyncedViewport = null;
    
    showDisconnectedUI();
}

// ============================================================
// SYNC LOGIC
// ============================================================

function listenToSession() {
    if (!sessionRef) return;
    
    console.log("Starting Firebase listener, isHost:", State.isStreamerHost());
    
    sessionRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (data && !State.isStreamerHost()) {
            // Throttle updates on viewer side
            pendingViewerData = data;
            if (!viewerUpdateThrottle) {
                viewerUpdateThrottle = setTimeout(() => {
                    viewerUpdateThrottle = null;
                    // Skip if we're in the middle of a re-render
                    if (pendingViewerData && !isRenderingGraph) {
                        applySessionData(pendingViewerData);
                        pendingViewerData = null;
                    }
                }, 150);
            }
        }
    });
}

export function syncToFirebase() {
    if (!sessionRef || !State.isStreamerHost() || isSyncing) return;
    
    isSyncing = true;
    try {
        sessionRef.update(getFullSyncState());
    } finally {
        isSyncing = false;
    }
}

export function syncViewportToFirebase() {
    if (!sessionRef || !State.isStreamerHost() || isRenderingGraph) return;
    
    if (viewportSyncThrottle) return;
    
    viewportSyncThrottle = setTimeout(() => {
        viewportSyncThrottle = null;
        
        State.saveAllNodePositions();
        
        const transform = State.getCurrentZoomTransform();
        const viewportData = {
            viewport: {
                x: transform?.x || 0,
                y: transform?.y || 0,
                k: transform?.k || 1,
                hostWidth: window.innerWidth,
                hostHeight: window.innerHeight
            }
        };
        
        // Add node positions
        const nodePositions = State.getNodePositions();
        const positions = {};
        nodePositions.forEach((pos, id) => {
            positions[encodeFirebaseKey(id)] = { x: pos.x, y: pos.y };
        });
        viewportData.nodePositions = positions;
        
        sessionRef.update(viewportData).catch(err => {
            console.error("Viewport sync error:", err);
        });
    }, 300);
}

// ============================================================
// STATE SERIALIZATION
// ============================================================

function encodeFirebaseKey(key) {
    return key
        .replace(/\./g, '%2E')
        .replace(/#/g, '%23')
        .replace(/\$/g, '%24')
        .replace(/\//g, '%2F')
        .replace(/\[/g, '%5B')
        .replace(/\]/g, '%5D');
}

function decodeFirebaseKey(key) {
    return key
        .replace(/%2E/g, '.')
        .replace(/%23/g, '#')
        .replace(/%24/g, '$')
        .replace(/%2F/g, '/')
        .replace(/%5B/g, '[')
        .replace(/%5D/g, ']');
}

function getFullSyncState() {
    // Save positions from simulation directly (without emitting events)
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
            
            nodesState[encodeFirebaseKey(n.id)] = {
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
            
            linksState[encodeFirebaseKey(sourceId) + '->' + encodeFirebaseKey(targetId)] = {
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
        selectedNodeId: State.getSelectedNodeId() ? encodeFirebaseKey(State.getSelectedNodeId()) : null,
        frontierHighlightActive: State.isFrontierHighlightActive(),
        nodes: nodesState,
        links: linksState
    };
}

// ============================================================
// STATE APPLICATION (viewer side)
// ============================================================

function applySessionData(data) {
    if (!data) return;

    const hasNodes = data.nodes && Object.keys(data.nodes).length > 0;

    // If viewer doesn't have graph data yet, build it from received state
    const currentGraphData = State.getGraphData();
    if (hasNodes && !currentGraphData) {
        buildGraphFromSessionData(data);
        return;
    }
    
    // Graph exists - apply visual state
    // applyVisualState returns true if a re-render was triggered
    const rerendering = applyVisualState(data);

    // Apply viewport only if not re-rendering (re-render preserves viewer's own viewport)
    if (data.viewport && !State.isStreamerHost() && !rerendering) {
        applyViewport(data.viewport);
    }
}

function buildGraphFromSessionData(data) {
    console.log("Building graph from session data...");
    
    const nodes = [];
    const explorationState = { discovered: new Set(), tags: new Map() };
    
    for (const [encodedId, nodeState] of Object.entries(data.nodes)) {
        const id = decodeFirebaseKey(encodedId);
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
            const [encodedSource, encodedTarget] = linkKey.split('->');
            links.push({
                source: decodeFirebaseKey(encodedSource),
                target: decodeFirebaseKey(encodedTarget),
                type: linkState.type || 'fog',
                oneWay: linkState.oneWay || false
            });
        }
    }
    
    const graphData = { nodes, links, metadata: {} };
    State.setGraphData(graphData);
    State.setExplorationState(explorationState);
    
    // Show main UI
    const uploadScreen = document.getElementById('upload-screen');
    if (uploadScreen) {
        uploadScreen.classList.add('hidden');
    }
    const mainUI = document.getElementById('main-ui');
    if (mainUI) {
        mainUI.classList.add('visible');
    }
    
    // Render graph
    State.emit('graphNeedsRender', { preservePositions: true });
    
    // Apply visual state after render
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
    
    // Check if viewport actually changed
    if (lastSyncedViewport &&
        Math.abs(vp.x - lastSyncedViewport.x) <= 1 &&
        Math.abs(vp.y - lastSyncedViewport.y) <= 1 &&
        Math.abs(vp.k - lastSyncedViewport.k) <= 0.01) {
        return;
    }
    
    lastSyncedViewport = { x: vp.x, y: vp.y, k: vp.k };
    
    // Validate viewport values
    if (!vp || typeof vp.x !== 'number' || typeof vp.y !== 'number' || typeof vp.k !== 'number' ||
        isNaN(vp.x) || isNaN(vp.y) || isNaN(vp.k) || !isFinite(vp.x) || !isFinite(vp.y) || !isFinite(vp.k) || vp.k <= 0) {
        console.warn("Invalid viewport data:", vp);
        return;
    }
    
    // Calculate adjusted coordinates
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

    // Save transform to State so it can be restored after re-renders
    const transform = d3.zoomIdentity.translate(x, y).scale(vp.k);
    State.setCurrentZoomTransform(transform);

    g.transition()
        .duration(300)
        .attr("transform", `translate(${x},${y}) scale(${vp.k})`);
}

function applyVisualState(data) {
    if (!data.nodes) return false;

    // Check if exploration mode changed
    if (data.explorationMode !== undefined) {
        const currentMode = State.isExplorationMode();
        if (data.explorationMode !== currentMode) {
            // Mode changed - update state and re-render graph
            State.setExplorationMode(data.explorationMode);
            isRenderingGraph = true;
            State.saveAllNodePositions();
            State.emit('graphNeedsRender', { preservePositions: true });
            setTimeout(() => {
                isRenderingGraph = false;
                applyVisualClasses(data);
                if (data.viewport) applyViewport(data.viewport);
            }, 200);
            return true; // Re-rendering
        }
    }

    const simulation = State.getSimulation();
    const d3Nodes = simulation ? simulation.nodes() : [];
    let positionsChanged = false;
    let explorationChanged = false;

    const explorationState = State.getExplorationState();
    
    // First pass: save ALL node positions from host (including nodes not yet visible)
    // This ensures newly discovered nodes will have correct positions when rendered
    for (const [encodedId, nodeState] of Object.entries(data.nodes)) {
        const id = decodeFirebaseKey(encodedId);
        if (nodeState.x !== undefined && nodeState.y !== undefined &&
            !isNaN(nodeState.x) && !isNaN(nodeState.y) && isFinite(nodeState.x) && isFinite(nodeState.y)) {
            State.saveNodePosition(id, nodeState.x, nodeState.y);
        }
    }

    // Second pass: apply states to existing simulation nodes and detect changes
    for (const [encodedId, nodeState] of Object.entries(data.nodes)) {
        const id = decodeFirebaseKey(encodedId);

        // Update position in simulation if node exists
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

        // Update exploration state
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
    
    // If exploration changed, re-render
    if (explorationChanged) {
        isRenderingGraph = true;
        State.saveAllNodePositions();

        State.emit('graphNeedsRender', { preservePositions: true });
        setTimeout(() => {
            isRenderingGraph = false;
            applyVisualClasses(data);
        }, 500);
        return true; // Re-rendering
    }

    // Update frontier highlight state (without triggering recalculation on viewer)
    if (data.frontierHighlightActive !== undefined) {
        const currentFrontierActive = State.isFrontierHighlightActive();
        if (data.frontierHighlightActive !== currentFrontierActive) {
            // Update button state without recalculating frontier
            updateFrontierCheckboxState(data.frontierHighlightActive);
        }
    }

    // Always apply visual classes from host - these include frontier highlights
    applyVisualClasses(data);

    if (positionsChanged) {
        updatePositionsInDOM(d3Nodes);
    }

    // Update selected node (including deselection when null)
    if (data.selectedNodeId !== undefined) {
        State.setSelectedNodeId(data.selectedNodeId ? decodeFirebaseKey(data.selectedNodeId) : null);
    }

    return false; // No re-render triggered
}

function updateFrontierCheckboxState(active) {
    // Update internal state without emitting event (to avoid recalculation)
    // We directly update the checkbox UI
    const frontierCheckbox = document.getElementById('show-frontier-checkbox');
    if (frontierCheckbox) {
        frontierCheckbox.checked = active;
    }
}

function applyVisualClasses(data) {
    const selectedId = data.selectedNodeId ? decodeFirebaseKey(data.selectedNodeId) : null;

    d3.selectAll(".node").each(function(d) {
        const encodedId = encodeFirebaseKey(d.id);
        const nodeState = data.nodes[encodedId];
        if (nodeState) {
            const node = d3.select(this);
            node.classed("highlighted", nodeState.highlighted || false)
                .classed("dimmed", nodeState.dimmed || false)
                .classed("frontier-highlight", nodeState.frontierHighlight || false)
                .classed("access-highlight", nodeState.accessHighlight || false)
                .classed("tag-highlighted", nodeState.tagHighlighted || false)
                .classed("viewer-selected", d.id === selectedId);

            // Add/remove selection ring for viewer mode
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
            const linkKey = `${encodeFirebaseKey(sourceId)}->${encodeFirebaseKey(targetId)}`;
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

// ============================================================
// UI FUNCTIONS
// ============================================================

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

// ============================================================
// UI EVENT LISTENERS
// ============================================================

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
                    copyUrlBtn.textContent = '✓ Copied!';
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

// ============================================================
// STATE EVENT SUBSCRIPTIONS
// ============================================================

// Sync to Firebase on relevant state changes
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
        // Small delay to ensure CSS classes are applied before sync
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
        // Small delay to ensure CSS classes are applied before sync
        setTimeout(() => syncToFirebase(), 50);
    }
});

State.subscribe('searchMatched', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        // Small delay to ensure CSS classes are applied before sync
        setTimeout(() => syncToFirebase(), 50);
    }
});

State.subscribe('searchCleared', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        // Small delay to ensure CSS classes are applied before sync
        setTimeout(() => syncToFirebase(), 50);
    }
});

State.subscribe('frontierHighlightChanged', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        // Small delay to ensure CSS classes are applied before sync
        setTimeout(() => syncToFirebase(), 50);
    }
});

State.subscribe('tagFilterChanged', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        // Small delay to ensure CSS classes are applied before sync
        setTimeout(() => syncToFirebase(), 50);
    }
});

State.subscribe('explorationModeChanged', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        // Delay to allow graph re-render to complete
        setTimeout(() => syncToFirebase(), 200);
    }
});

State.subscribe('graphRenderCompleted', () => {
    if (State.isFirebaseConnected() && State.isStreamerHost()) {
        syncToFirebase();
    }
});
