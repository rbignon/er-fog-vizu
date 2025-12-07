// ============================================================
// EXPLORATION MODE - Discovery, propagation, path finding
// ============================================================

import * as State from './state.js';

// ============================================================
// DISCOVERY LOGIC
// ============================================================

/**
 * Initialize exploration state with starting area
 */
export function initExplorationState() {
    State.setExplorationState({
        discovered: new Set(),
        tags: new Map()
    });
    
    // Discover starting area and propagate through pre-existing connections
    discoverWithPreexisting(State.START_NODE);
    State.saveExplorationToStorage();
}

/**
 * Reset exploration state to initial
 */
export function resetExplorationState() {
    State.clearExplorationStorage();
    initExplorationState();
    State.emit('explorationReset');
}

/**
 * Load existing exploration state from storage
 */
export function loadExplorationState(seed) {
    const saved = State.loadExplorationFromStorage(seed);
    if (saved) {
        State.setExplorationState(saved);
        return true;
    }
    return false;
}

/**
 * Discover an area and propagate through pre-existing connections
 */
export function discoverArea(areaId) {
    State.saveAllNodePositions();
    discoverWithPreexisting(areaId);
    State.saveExplorationToStorage();
    State.emit('graphNeedsRender', { preservePositions: true });
}

/**
 * Undiscover an area and all areas that become unreachable (except starting area)
 */
export function undiscoverArea(areaId) {
    if (areaId === State.START_NODE) return;

    State.saveAllNodePositions();

    const graphData = State.getGraphData();
    const explorationState = State.getExplorationState();
    if (!graphData || !explorationState) return;

    // First, undiscover the requested node
    State.undiscoverNode(areaId);

    // Find all nodes that are no longer reachable from START_NODE
    const reachableFromStart = findReachableNodes(State.START_NODE, graphData.links, explorationState.discovered);

    // Undiscover all nodes that are no longer reachable
    const toUndiscover = [];
    explorationState.discovered.forEach(nodeId => {
        if (!reachableFromStart.has(nodeId)) {
            toUndiscover.push(nodeId);
        }
    });

    toUndiscover.forEach(nodeId => {
        State.undiscoverNode(nodeId);
    });

    State.saveExplorationToStorage();
    State.emit('graphNeedsRender', { preservePositions: true });
}

/**
 * Find all nodes reachable from a starting node through discovered nodes
 */
function findReachableNodes(startNodeId, links, discoveredSet) {
    const reachable = new Set([startNodeId]);
    const queue = [startNodeId];

    while (queue.length > 0) {
        const currentId = queue.shift();

        links.forEach(link => {
            const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
            const targetId = typeof link.target === 'object' ? link.target.id : link.target;

            // Can go FROM currentId TO target (following link direction)
            if (sourceId === currentId && discoveredSet.has(targetId) && !reachable.has(targetId)) {
                reachable.add(targetId);
                queue.push(targetId);
            }
            // Can go FROM target TO currentId only if link is NOT one-way
            if (targetId === currentId && !link.oneWay && discoveredSet.has(sourceId) && !reachable.has(sourceId)) {
                reachable.add(sourceId);
                queue.push(sourceId);
            }
        });
    }

    return reachable;
}

/**
 * Internal: discover area and recursively discover pre-existing connections
 */
function discoverWithPreexisting(areaId) {
    const explorationState = State.getExplorationState();
    if (explorationState.discovered.has(areaId)) return;
    
    State.discoverNode(areaId);
    
    const graphData = State.getGraphData();
    if (!graphData) return;
    
    // Find and follow pre-existing connections (respecting one-way)
    graphData.links.forEach(link => {
        if (link.type !== 'preexisting') return;
        
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        
        // Can go FROM areaId TO target (following link direction)
        if (sourceId === areaId && !explorationState.discovered.has(targetId)) {
            discoverWithPreexisting(targetId);
        }
        // Can go FROM target TO areaId only if link is NOT one-way
        else if (targetId === areaId && !explorationState.discovered.has(sourceId) && !link.oneWay) {
            discoverWithPreexisting(sourceId);
        }
    });
}

/**
 * Propagate discovery through pre-existing connections for all discovered areas
 * (called after graph data is loaded to sync state)
 */
export function propagatePreexistingDiscoveries() {
    const explorationState = State.getExplorationState();
    const graphData = State.getGraphData();
    if (!explorationState || !graphData) return;
    
    const toPropagate = Array.from(explorationState.discovered);
    toPropagate.forEach(areaId => {
        graphData.links.forEach(link => {
            if (link.type !== 'preexisting') return;
            
            const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
            const targetId = typeof link.target === 'object' ? link.target.id : link.target;
            
            if (sourceId === areaId && !explorationState.discovered.has(targetId)) {
                discoverWithPreexisting(targetId);
            } else if (targetId === areaId && !explorationState.discovered.has(sourceId) && !link.oneWay) {
                discoverWithPreexisting(sourceId);
            }
        });
    });
}

// ============================================================
// PATH FINDING
// ============================================================

/**
 * Discover all nodes on the path from Starting Area to target
 */
export function discoverPathTo(targetId) {
    const graphData = State.getGraphData();
    if (!graphData) return;
    
    // BFS to find shortest path (using all nodes, not just discovered)
    const visited = new Set([State.START_NODE]);
    const queue = [[State.START_NODE, [State.START_NODE]]];
    
    while (queue.length > 0) {
        const [currentId, path] = queue.shift();
        
        if (currentId === targetId) {
            // Found the target - discover all nodes on the path
            State.saveAllNodePositions();
            
            let discoveredCount = 0;
            path.forEach(nodeId => {
                if (!State.isDiscovered(nodeId)) {
                    discoverWithPreexisting(nodeId);
                    discoveredCount++;
                }
            });
            
            State.saveExplorationToStorage();
            State.emit('graphNeedsRender', { preservePositions: true });
            showDiscoveryNotification(discoveredCount, targetId);
            return;
        }
        
        // Find all neighbors (respecting one-way links)
        graphData.links.forEach(link => {
            const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
            const targetNodeId = typeof link.target === 'object' ? link.target.id : link.target;
            
            let neighborId = null;
            // Can always follow link direction
            if (sourceId === currentId) {
                neighborId = targetNodeId;
            }
            // Can go backwards only if link is NOT one-way
            else if (targetNodeId === currentId && !link.oneWay) {
                neighborId = sourceId;
            }
            
            if (neighborId && !visited.has(neighborId)) {
                visited.add(neighborId);
                queue.push([neighborId, [...path, neighborId]]);
            }
        });
    }
    
    console.warn('No path found to', targetId);
}

/**
 * Find path from start node to target using BFS
 */
export function findPathFromStart(targetNodeId) {
    if (targetNodeId === State.START_NODE) {
        return { nodes: new Set([State.START_NODE]), links: new Set() };
    }
    
    const graphData = State.getGraphData();
    if (!graphData) return { nodes: new Set(), links: new Set() };
    
    // Build node connections map
    const nodeConnections = buildNodeConnectionsMap(graphData);
    
    // In exploration mode, only traverse through discovered nodes
    const explorationMode = State.isExplorationMode();
    const explorationState = State.getExplorationState();
    const canTraverse = (nodeId) => {
        if (!explorationMode) return true;
        return explorationState.discovered.has(nodeId);
    };
    
    const visited = new Set([State.START_NODE]);
    const queue = [[State.START_NODE, [], []]]; // [nodeId, pathNodes, pathLinks]
    
    while (queue.length > 0) {
        const [currentId, pathNodes, pathLinks] = queue.shift();
        const conns = nodeConnections.get(currentId);
        if (!conns) continue;
        
        // Follow outgoing links
        for (const link of conns.outgoing) {
            const targetId = typeof link.target === 'object' ? link.target.id : link.target;
            
            if (visited.has(targetId)) continue;
            if (targetId !== targetNodeId && !canTraverse(targetId)) continue;
            visited.add(targetId);
            
            const newPathNodes = [...pathNodes, currentId];
            const newPathLinks = [...pathLinks, link];
            
            if (targetId === targetNodeId) {
                return {
                    nodes: new Set([...newPathNodes, targetId]),
                    links: new Set(newPathLinks)
                };
            }
            
            queue.push([targetId, newPathNodes, newPathLinks]);
        }
        
        // Follow incoming links (backwards through bidirectional)
        for (const link of conns.incoming) {
            if (link.oneWay) continue;
            
            const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
            
            if (visited.has(sourceId)) continue;
            if (sourceId !== targetNodeId && !canTraverse(sourceId)) continue;
            visited.add(sourceId);
            
            const newPathNodes = [...pathNodes, currentId];
            const newPathLinks = [...pathLinks, link];
            
            if (sourceId === targetNodeId) {
                return {
                    nodes: new Set([...newPathNodes, sourceId]),
                    links: new Set(newPathLinks)
                };
            }
            
            queue.push([sourceId, newPathNodes, newPathLinks]);
        }
    }
    
    return { nodes: new Set(), links: new Set() };
}

/**
 * Follow linear path from a node (subway line behavior)
 * In exploration mode, stops at undiscovered nodes (frontier boundary)
 */
export function followLinearPath(startNodeId) {
    const graphData = State.getGraphData();
    if (!graphData) return { nodes: new Set([startNodeId]), links: new Set() };

    // In exploration mode, only traverse through discovered nodes
    const explorationMode = State.isExplorationMode();
    const explorationState = State.getExplorationState();
    const canTraverse = (nodeId) => {
        if (!explorationMode) return true;
        return explorationState.discovered.has(nodeId);
    };

    const nodeConnections = buildNodeConnectionsMap(graphData);
    const visitedNodes = new Set([startNodeId]);
    const visitedLinks = new Set();
    const queue = [startNodeId];

    while (queue.length > 0) {
        const currentId = queue.shift();
        const conns = nodeConnections.get(currentId);
        if (!conns) continue;

        [...conns.incoming, ...conns.outgoing].forEach(link => {
            const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
            const targetId = typeof link.target === 'object' ? link.target.id : link.target;
            const neighborId = sourceId === currentId ? targetId : sourceId;

            if (visitedNodes.has(neighborId)) return;

            // In exploration mode, stop at undiscovered nodes
            if (!canTraverse(neighborId)) return;

            visitedLinks.add(link);
            visitedNodes.add(neighborId);

            // Continue following if not a hub
            const neighborConns = nodeConnections.get(neighborId);
            if (neighborConns && neighborConns.degree < 3) {
                queue.push(neighborId);
            }
        });
    }

    return { nodes: visitedNodes, links: visitedLinks };
}

// ============================================================
// NODE STATUS
// ============================================================

/**
 * Get exploration status for a node
 */
export function getNodeExplorationStatus(nodeId, links) {
    if (!State.isExplorationMode()) {
        return { visible: true, discovered: true, accessible: true };
    }
    
    const explorationState = State.getExplorationState();
    const isDiscovered = explorationState.discovered.has(nodeId);
    
    if (isDiscovered) {
        return { visible: true, discovered: true, accessible: true };
    }
    
    // Check if accessible (can reach from a discovered node)
    const isAccessible = links.some(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        
        // Link goes FROM discovered TO nodeId
        if (sourceId !== nodeId && targetId === nodeId && explorationState.discovered.has(sourceId)) {
            return true;
        }
        // Link goes FROM nodeId TO discovered, but only if NOT one-way
        if (sourceId === nodeId && targetId !== nodeId && explorationState.discovered.has(targetId) && !link.oneWay) {
            return true;
        }
        
        return false;
    });
    
    return { visible: isAccessible, discovered: false, accessible: isAccessible };
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Build a map of node connections from graph data
 */
export function buildNodeConnectionsMap(graphData) {
    const nodeConnections = new Map();
    
    graphData.nodes.forEach(n => {
        nodeConnections.set(n.id, { incoming: [], outgoing: [], degree: 0 });
    });
    
    graphData.links.forEach(l => {
        const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
        const targetId = typeof l.target === 'object' ? l.target.id : l.target;
        const isSelfLoop = sourceId === targetId;
        
        const sourceConns = nodeConnections.get(sourceId);
        const targetConns = nodeConnections.get(targetId);
        
        if (sourceConns) {
            sourceConns.outgoing.push(l);
            sourceConns.degree++;
        }
        if (targetConns && !isSelfLoop) {
            targetConns.incoming.push(l);
            targetConns.degree++;
        }
    });
    
    return nodeConnections;
}

/**
 * Compute one-way property on links
 */
export function computeOneWayLinks(links) {
    if (!links || links.length === 0) return;
    
    const linkPairs = new Set();
    links.forEach(l => {
        const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
        const targetId = typeof l.target === 'object' ? l.target.id : l.target;
        linkPairs.add(`${sourceId}|${targetId}`);
    });
    
    links.forEach(l => {
        const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
        const targetId = typeof l.target === 'object' ? l.target.id : l.target;
        l.oneWay = !linkPairs.has(`${targetId}|${sourceId}`);
    });
}

/**
 * Show discovery notification
 */
function showDiscoveryNotification(count, targetName) {
    let notification = document.getElementById('discovery-notification');
    if (!notification) {
        notification = document.createElement('div');
        notification.id = 'discovery-notification';
        document.body.appendChild(notification);
    }
    
    notification.textContent = `✓ ${count} area${count > 1 ? 's' : ''} discovered on path to "${targetName}"`;
    notification.classList.add('visible');
    
    setTimeout(() => {
        notification.classList.remove('visible');
    }, 3000);
}

/**
 * Toggle a tag on a node
 */
export function toggleTag(nodeId, tagId) {
    const newTags = State.toggleNodeTag(nodeId, tagId);
    State.saveExplorationToStorage();
    State.emit('nodeTagsUpdated', { nodeId, tags: newTags });
    return newTags;
}
