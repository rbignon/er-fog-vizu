// ============================================================
// GRAPH - D3.js rendering, simulation, interactions
// ============================================================

import { ItemLogParser } from './parser.js';
import * as State from './state.js';
import * as Exploration from './exploration.js';

// ============================================================
// RENDER GRAPH
// ============================================================

export function renderGraph(preservePositions = false) {
    const graphData = State.getGraphData();
    if (!graphData) return;
    
    const explorationMode = State.isExplorationMode();
    const explorationState = State.getExplorationState();
    
    // Propagate discoveries through pre-existing connections
    if (explorationMode && explorationState) {
        Exploration.propagatePreexistingDiscoveries();
        State.saveExplorationToStorage();
    }
    
    // Clear previous graph
    d3.select("svg").selectAll("*").remove();
    
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    const svg = d3.select("svg")
        .attr("viewBox", [0, 0, width, height]);
    
    // Create container for zoom
    const container = svg.append("g");
    
    // Zoom behavior
    const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on("zoom", (event) => {
            container.attr("transform", event.transform);
            State.setCurrentZoomTransform(event.transform);
            State.emit('viewportChanged', event.transform);
        });
    
    svg.call(zoom);
    
    // Restore zoom if preserving positions
    const savedTransform = State.getCurrentZoomTransform();
    if (preservePositions && savedTransform &&
        isFinite(savedTransform.x) && isFinite(savedTransform.y) && isFinite(savedTransform.k)) {
        svg.call(zoom.transform, savedTransform);
    }
    
    // Arrow markers (defs)
    svg.append("defs");
    
    // Process data (deep clone to avoid mutation)
    const nodes = graphData.nodes.map(d => ({...d}));
    const links = graphData.links.map(d => ({...d}));
    
    // Create node map
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    
    // Build connections map
    const nodeConnections = Exploration.buildNodeConnectionsMap({ nodes, links });
    
    // Update stats
    document.getElementById("area-count").textContent = nodes.length;
    document.getElementById("random-count").textContent = links.filter(l => l.type === "random").length;
    document.getElementById("preexisting-count").textContent = links.filter(l => l.type === "preexisting").length;
    
    // Show/hide "Requires Key Item" legend
    const hasRequiredItems = links.some(l => l.requiredItemFrom);
    document.getElementById("legend-requires-item").classList.toggle('hidden', !hasRequiredItems);
    
    // Update seed display
    if (graphData.metadata && graphData.metadata.seed) {
        document.getElementById("seed-info").textContent = `Seed: ${graphData.metadata.seed}`;
    } else {
        document.getElementById("seed-info").textContent = 'Spoiler Log Visualizer';
    }
    
    // Update button visibility
    updateButtonVisibility(explorationMode);
    
    // Mark hub nodes (3+ connections)
    nodes.forEach(n => {
        const conns = nodeConnections.get(n.id);
        n.isHub = conns && conns.degree >= 3;
    });
    
    document.getElementById("hub-count").textContent = nodes.filter(n => n.isHub).length;
    
    // Compute exploration status for each node
    nodes.forEach(d => {
        d.explorationStatus = Exploration.getNodeExplorationStatus(d.id, links);
    });
    
    // Filter visible nodes/links in exploration mode
    const visibleNodes = explorationMode
        ? nodes.filter(d => d.explorationStatus.visible)
        : nodes;
    const visibleNodeIds = new Set(visibleNodes.map(d => d.id));
    const discoveredNodeIds = explorationMode && explorationState
        ? new Set(explorationState.discovered)
        : new Set(nodes.map(n => n.id));
    const visibleLinks = explorationMode
        ? links.filter(l => {
            const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
            const targetId = typeof l.target === 'object' ? l.target.id : l.target;
            if (!visibleNodeIds.has(sourceId) || !visibleNodeIds.has(targetId)) return false;
            return discoveredNodeIds.has(sourceId) || discoveredNodeIds.has(targetId);
        })
        : links;
    
    // Stop previous simulation
    const oldSimulation = State.getSimulation();
    if (oldSimulation) oldSimulation.stop();
    
    // Restore node positions if preserving layout
    if (preservePositions) {
        restoreNodePositions(visibleNodes, visibleLinks);
    }
    
    // Create force simulation
    const simulation = d3.forceSimulation(visibleNodes)
        .force("link", d3.forceLink(visibleLinks)
            .id(d => d.id)
            .distance(100)
            .strength(0.5))
        .force("charge", d3.forceManyBody()
            .strength(-300)
            .distanceMax(500))
        .force("center", preservePositions ? null : d3.forceCenter(width / 2, height / 2))
        .force("collision", d3.forceCollide().radius(30))
        .force("x", preservePositions ? null : d3.forceX(width / 2).strength(0.03))
        .force("y", preservePositions ? null : d3.forceY(height / 2).strength(0.03));
    
    State.setSimulation(simulation);
    
    // Unfreeze nodes after layout stabilizes
    if (preservePositions) {
        unfreezeNodesAfterDelay(simulation);
    }
    
    // Draw links (path 'd' attribute will be set by tick handler)
    const link = container.append("g")
        .attr("class", "links")
        .selectAll("path")
        .data(visibleLinks)
        .join("path")
        .attr("class", d => {
            let cls = `link ${d.type}`;
            if (d.requiredItemFrom) cls += ' requires-item';
            return cls;
        });
    
    // Draw nodes
    const node = container.append("g")
        .attr("class", "nodes")
        .selectAll("g")
        .data(visibleNodes)
        .join("g")
        .attr("class", d => getNodeClass(d, explorationMode))
        .call(d3.drag()
            .on("start", (event) => dragstarted(event, simulation))
            .on("drag", dragged)
            .on("end", (event) => dragended(event, simulation)));
    
    node.append("circle")
        .attr("r", d => {
            if (explorationMode && !d.explorationStatus.discovered) return 7;
            return d.isBoss ? 10 : 7;
        });
    
    node.append("text")
        .attr("dx", 12)
        .attr("dy", 4)
        .text(d => getNodeLabel(d, explorationMode, explorationState));
    
    // Setup interactions
    setupTooltip(node, nodeConnections, explorationMode, explorationState);
    setupNodeClick(node, svg, nodeConnections, explorationMode, explorationState);
    setupSearch(node, link, nodes);
    
    // Simulation tick handler
    simulation.on("tick", () => {
        link.attr("d", d => {
            const sx = d.source.x ?? 0, sy = d.source.y ?? 0;
            const tx = d.target.x ?? 0, ty = d.target.y ?? 0;
            const dx = tx - sx;
            const dy = ty - sy;
            const dr = Math.sqrt(dx * dx + dy * dy) * 2;
            return `M${sx},${sy}A${dr},${dr} 0 0,1 ${tx},${ty}`;
        });
        
        node.attr("transform", d => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });
    
    // Initial zoom to fit (only on first render)
    if (!preservePositions) {
        setTimeout(() => {
            const bounds = container.node()?.getBBox();
            if (!bounds || bounds.width === 0 || bounds.height === 0) return;
            
            const fullWidth = bounds.width;
            const fullHeight = bounds.height;
            const midX = bounds.x + fullWidth / 2;
            const midY = bounds.y + fullHeight / 2;
            
            const scale = 0.8 / Math.max(fullWidth / width, fullHeight / height);
            if (!isFinite(scale) || scale <= 0) return;
            
            const translate = [width / 2 - scale * midX, height / 2 - scale * midY];
            if (!isFinite(translate[0]) || !isFinite(translate[1])) return;
            
            svg.transition()
                .duration(750)
                .call(zoom.transform, d3.zoomIdentity
                    .translate(translate[0], translate[1])
                    .scale(scale));
        }, 2000);
    }
    
    // Re-apply frontier highlight if active
    if (State.isFrontierHighlightActive()) {
        setTimeout(() => State.emit('frontierHighlightChanged', true), 100);
    }

    // Sync to Firebase after render completes (to capture restored highlights)
    if (preservePositions) {
        setTimeout(() => State.emit('graphRenderCompleted'), 150);
    }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function updateButtonVisibility(explorationMode) {
    const resetBtn = document.getElementById('reset-exploration-btn');
    const frontierCheckbox = document.getElementById('show-frontier-checkbox');
    const frontierLabel = frontierCheckbox?.closest('label');

    if (resetBtn) resetBtn.classList.toggle('hidden', !explorationMode);
    if (frontierLabel) {
        frontierLabel.classList.toggle('hidden', !explorationMode);
    }
    if (frontierCheckbox) {
        frontierCheckbox.checked = false;
    }
}

function getNodeClass(d, explorationMode) {
    let cls = "node";
    
    if (explorationMode && !d.explorationStatus.discovered) {
        cls += " undiscovered";
        if (d.explorationStatus.accessible) cls += " accessible";
    } else {
        if (d.id === State.START_NODE) cls += " start";
        else if (d.id === "Stone Platform") cls += " end";
        else if (d.isBoss) cls += " boss";
        else cls += " normal";
        if (d.isHub) cls += " hub";
    }
    
    return cls;
}

function getNodeLabel(d, explorationMode, explorationState) {
    if (explorationMode && !d.explorationStatus.discovered) {
        return "???";
    }
    
    let label = d.id;
    if (explorationMode && explorationState && explorationState.tags) {
        const tags = explorationState.tags.get(d.id);
        if (tags && tags.length > 0) {
            const emojis = tags.map(tagId => {
                const tag = State.AVAILABLE_TAGS.find(t => t.id === tagId);
                return tag ? tag.emoji : '';
            }).filter(e => e).join('');
            label += ' ' + emojis;
        }
    }
    
    return label;
}

function restoreNodePositions(nodes, links) {
    const nodePositions = State.getNodePositions();
    
    // First pass: restore known positions
    nodes.forEach(node => {
        const savedPos = nodePositions.get(node.id);
        if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number' &&
            !isNaN(savedPos.x) && !isNaN(savedPos.y) && isFinite(savedPos.x) && isFinite(savedPos.y)) {
            node.x = savedPos.x;
            node.y = savedPos.y;
            node.fx = savedPos.x;
            node.fy = savedPos.y;
        }
    });
    
    // Second pass: initialize new nodes near neighbors
    nodes.forEach(node => {
        if (node.x === undefined || node.y === undefined || isNaN(node.x) || isNaN(node.y)) {
            const connectedLink = links?.find(l => {
                const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
                const targetId = typeof l.target === 'object' ? l.target.id : l.target;
                return sourceId === node.id || targetId === node.id;
            });
            
            if (connectedLink) {
                const sourceId = typeof connectedLink.source === 'object' ? connectedLink.source.id : connectedLink.source;
                const targetId = typeof connectedLink.target === 'object' ? connectedLink.target.id : connectedLink.target;
                const neighborId = sourceId === node.id ? targetId : sourceId;
                const neighborNode = nodes.find(n => n.id === neighborId);
                
                if (neighborNode && typeof neighborNode.x === 'number' && typeof neighborNode.y === 'number' &&
                    !isNaN(neighborNode.x) && !isNaN(neighborNode.y)) {
                    node.x = neighborNode.x + (Math.random() - 0.5) * 100;
                    node.y = neighborNode.y + (Math.random() - 0.5) * 100;
                }
            }
            
            if (node.x === undefined || isNaN(node.x) || isNaN(node.y)) {
                node.x = window.innerWidth / 2 + (Math.random() - 0.5) * 200;
                node.y = window.innerHeight / 2 + (Math.random() - 0.5) * 200;
            }
        }
    });
}

function unfreezeNodesAfterDelay(simulation) {
    setTimeout(() => {
        const nodePositions = State.getNodePositions();
        simulation.nodes().forEach(node => {
            if (nodePositions.has(node.id)) {
                node.fx = null;
                node.fy = null;
            }
        });
        simulation.alpha(0.1).restart();
    }, 500);
}

// ============================================================
// DRAG HANDLERS
// ============================================================

function dragstarted(event, simulation) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    event.subject.fx = event.subject.x;
    event.subject.fy = event.subject.y;
}

function dragged(event) {
    event.subject.fx = event.x;
    event.subject.fy = event.y;
}

function dragended(event, simulation) {
    if (!event.active) simulation.alphaTarget(0);
    event.subject.fx = null;
    event.subject.fy = null;
    
    State.saveAllNodePositions();
    State.emit('nodePositionsSaved');
}

// ============================================================
// TOOLTIP
// ============================================================

function setupTooltip(node, nodeConnections, explorationMode, explorationState) {
    const tooltip = d3.select("#tooltip");
    // Check if tooltip was already pinned (survives re-render)
    let tooltipPinned = tooltip.classed("pinned");
    let isDraggingTooltip = false;
    let tooltipDragOffset = { x: 0, y: 0 };

    // Tooltip drag
    tooltip.on("mousedown", function(event) {
        if (event.target.tagName === 'H3' && tooltipPinned) {
            isDraggingTooltip = true;
            const rect = this.getBoundingClientRect();
            tooltipDragOffset.x = event.clientX - rect.left;
            tooltipDragOffset.y = event.clientY - rect.top;
            event.preventDefault();
        }
    });
    
    d3.select(document).on("mousemove.tooltip", function(event) {
        if (isDraggingTooltip) {
            tooltip.style("left", (event.clientX - tooltipDragOffset.x) + "px")
                   .style("top", (event.clientY - tooltipDragOffset.y) + "px");
        }
    });
    
    d3.select(document).on("mouseup.tooltip", function() {
        isDraggingTooltip = false;
    });

    // Track current tooltip node for refresh
    let currentTooltipNode = null;
    let currentTooltipPosition = null;

    function refreshTooltip() {
        if (currentTooltipNode && currentTooltipPosition) {
            // Refresh with updated exploration state
            const content = buildTooltipContent(currentTooltipNode, nodeConnections, explorationMode, State.getExplorationState(), true);
            tooltip.html(`<span class="close-btn">&times;</span>${content}`);
            setupTooltipHandlers();
        }
    }
    
    function setupTooltipHandlers() {
        tooltip.select(".close-btn").on("click", () => hideTooltip());
        
        // Discover/undiscover buttons
        tooltip.select(".discover-btn").on("click", function() {
            const nodeId = this.getAttribute("data-node-id");
            if (nodeId) {
                Exploration.discoverArea(nodeId);
                // Refresh tooltip to show updated state
                setTimeout(refreshTooltip, 100);
            }
        });
        
        tooltip.select(".undiscover-btn").on("click", function() {
            const nodeId = this.getAttribute("data-node-id");
            if (nodeId) {
                Exploration.undiscoverArea(nodeId);
                // Refresh tooltip to show updated state
                setTimeout(refreshTooltip, 100);
            }
        });
        
        // Tag toggles
        tooltip.selectAll(".node-tag.clickable").on("click", function() {
            const tagId = this.getAttribute("data-tag-id");
            const nodeId = this.getAttribute("data-node-id");
            if (tagId && nodeId) {
                Exploration.toggleTag(nodeId, tagId);
                d3.select(this).classed("inactive", !d3.select(this).classed("inactive"));
            }
        });
    }
    
    function showTooltip(event, d, pinned = false) {
        currentTooltipNode = d;
        currentTooltipPosition = { x: event.pageX, y: event.pageY };
        
        const content = buildTooltipContent(d, nodeConnections, explorationMode, explorationState, pinned);
        tooltip.html(`<span class="close-btn">&times;</span>${content}`)
            .style("left", (event.pageX + 15) + "px")
            .style("top", Math.min(event.pageY - 10, window.innerHeight - 400) + "px")
            .classed("visible", true)
            .classed("pinned", pinned);
        
        setupTooltipHandlers();
    }
    
    function hideTooltip() {
        tooltip.classed("visible", false).classed("pinned", false);
        tooltipPinned = false;
        currentTooltipNode = null;
        currentTooltipPosition = null;
        State.setSelectedNodeId(null);
    }

    // Restore tooltip state if it was pinned before re-render
    if (tooltipPinned) {
        const selectedNodeId = State.getSelectedNodeId();
        if (selectedNodeId) {
            const selectedNodeData = node.data().find(n => n.id === selectedNodeId);
            if (selectedNodeData) {
                currentTooltipNode = selectedNodeData;
                // Re-setup handlers for the existing tooltip content
                setupTooltipHandlers();
            }
        }
    }

    node.on("mouseenter", (event, d) => {
        if (!tooltipPinned) showTooltip(event, d, false);
    })
    .on("mousemove", (event) => {
        if (!tooltipPinned) {
            tooltip.style("left", (event.pageX + 15) + "px")
                .style("top", Math.min(event.pageY - 10, window.innerHeight - 400) + "px");
        }
    })
    .on("mouseleave", () => {
        if (!tooltipPinned) tooltip.classed("visible", false);
    });
    
    // Expose for click handler
    node.showTooltipPinned = (event, d) => {
        tooltipPinned = true;
        showTooltip(event, d, true);
    };
    
    node.hideTooltip = hideTooltip;
    node.isTooltipPinned = () => tooltipPinned;
}

function buildTooltipContent(d, nodeConnections, explorationMode, explorationState, pinned) {
    const conns = nodeConnections.get(d.id);
    const isUndiscovered = explorationMode && explorationState && !explorationState.discovered.has(d.id);
    const itemLogData = State.getItemLogData();
    
    let html = '';
    
    if (isUndiscovered) {
        html = `<h3>??? (Unknown Area)</h3>`;
        html += `<p class="scaling" style="font-style: italic; color: #6a5a4a;">Discover this area to reveal its details</p>`;
    } else {
        html = `<h3>${d.id}${d.isBoss ? '<span class="boss-badge">Boss</span>' : ''}</h3>`;
        
        if (d.scaling) {
            html += `<p class="scaling">Scaling: ${d.scaling}</p>`;
        }
        
        // Tags
        if (explorationMode && explorationState) {
            const activeTags = explorationState.tags.get(d.id) || [];
            
            if (pinned) {
                html += '<div class="node-tags">';
                State.AVAILABLE_TAGS.forEach(tag => {
                    const isActive = activeTags.includes(tag.id);
                    html += `<span class="node-tag clickable${isActive ? '' : ' inactive'}" data-tag-id="${tag.id}" data-node-id="${d.id}">${tag.emoji}</span>`;
                });
                html += '</div>';
            } else if (activeTags.length > 0) {
                html += '<div class="node-tags">';
                activeTags.forEach(tagId => {
                    const tag = State.AVAILABLE_TAGS.find(t => t.id === tagId);
                    if (tag) html += `<span class="node-tag">${tag.emoji}</span>`;
                });
                html += '</div>';
            }
        }
        
        // Key items
        if (itemLogData) {
            const keyItems = ItemLogParser.findKeyItemsForArea(itemLogData.keyItems, d.id);
            if (keyItems.length > 0) {
                html += '<div class="key-items"><div class="conn-title">Key Items</div>';
                keyItems.forEach(item => html += `<div class="key-item">${item}</div>`);
                html += '</div>';
            }
        }
    }
    
    // Connections
    if (conns && (conns.incoming.length > 0 || conns.outgoing.length > 0)) {
        html += '<div class="connections">';
        
        const incomingToShow = isUndiscovered
            ? conns.incoming.filter(c => {
                const sourceName = typeof c.source === 'object' ? c.source.id : c.source;
                return explorationState && explorationState.discovered.has(sourceName);
            })
            : conns.incoming;
        
        if (incomingToShow.length > 0) {
            html += `<div class="conn-title">${isUndiscovered ? 'How to reach' : 'Entrances'}</div>`;
            html += buildConnectionsList(incomingToShow, 'incoming', isUndiscovered, explorationMode, explorationState, pinned, itemLogData);
        }
        
        if (!isUndiscovered && conns.outgoing.length > 0) {
            html += '<div class="conn-title" style="margin-top: 8px;">Exits</div>';
            html += buildConnectionsList(conns.outgoing, 'outgoing', false, explorationMode, explorationState, pinned, itemLogData);
        }
        
        html += '</div>';
    }
    
    // Action buttons
    if (isUndiscovered && pinned) {
        html += `<button class="discover-btn" data-node-id="${d.id}">🔍 Discover this area</button>`;
    }
    
    if (explorationMode && !isUndiscovered && pinned && d.id !== State.START_NODE) {
        html += `<button class="undiscover-btn" data-node-id="${d.id}">↩️ Mark as undiscovered</button>`;
    }
    
    return html;
}

function buildConnectionsList(connections, direction, isUndiscovered, explorationMode, explorationState, pinned, itemLogData) {
    let html = '';
    const maxShow = pinned ? connections.length : 5;
    
    connections.slice(0, maxShow).forEach(c => {
        const sourceName = typeof c.source === 'object' ? c.source.id : c.source;
        const targetName = typeof c.target === 'object' ? c.target.id : c.target;
        const name = direction === 'incoming' ? sourceName : targetName;
        const sourceDetails = c.sourceDetails || '';
        const targetDetails = c.targetDetails || '';
        const hasReq = c.requiredItemFrom;
        
        // For outgoing, check if target is discovered
        let displayName = name;
        if (direction === 'outgoing' && explorationMode && explorationState && !explorationState.discovered.has(targetName)) {
            displayName = '???';
        }
        
        html += `<div class="conn-item ${c.type}${hasReq ? ' has-requirement' : ''}">`;
        html += direction === 'incoming' ? `← ${displayName}` : `→ ${displayName}`;
        
        // Details
        if (isUndiscovered && direction === 'incoming') {
            if (sourceDetails) html += `<div class="conn-details">From: ${sourceDetails}</div>`;
        } else if (displayName !== '???' && (sourceDetails || targetDetails)) {
            html += `<div class="conn-details">`;
            if (sourceDetails) html += `From: ${sourceDetails}`;
            if (sourceDetails && targetDetails) html += `<br>`;
            if (targetDetails) html += `To: ${targetDetails}`;
            html += `</div>`;
        } else if (displayName === '???' && sourceDetails) {
            html += `<div class="conn-details">From: ${sourceDetails}</div>`;
        }
        
        // Required item info
        if (hasReq && itemLogData) {
            const reqItems = ItemLogParser.findKeyItemInZone(itemLogData.keyItems, c.requiredItemFrom);
            if (reqItems.length > 0) {
                html += `<div class="requires-info">🔑 Requires: ${reqItems.join(' or ')}<br>📍 Found in: ${c.requiredItemFrom}</div>`;
            } else {
                html += `<div class="requires-info">🔑 Requires item from: ${c.requiredItemFrom}</div>`;
            }
        } else if (hasReq) {
            html += `<div class="requires-info">🔑 Requires item from: ${c.requiredItemFrom}</div>`;
        }
        
        html += `</div>`;
    });
    
    if (!pinned && connections.length > 5) {
        html += `<div class="conn-item" style="color: #6a5d45;">... click to see ${connections.length - 5} more</div>`;
    }
    
    return html;
}

// ============================================================
// NODE CLICK
// ============================================================

function setupNodeClick(node, svg, nodeConnections, explorationMode, explorationState) {
    // Restore selected node from state if exists
    let selectedNode = State.getSelectedNodeId();

    // Helper function to apply selection highlights
    function applySelectionHighlights(nodeId) {
        const localResult = Exploration.followLinearPath(nodeId);
        let connectedNodes = localResult.nodes;
        let connectedLinks = localResult.links;

        const showPathFromStart = document.getElementById('show-path-from-start')?.checked;
        if (showPathFromStart) {
            const pathResult = Exploration.findPathFromStart(nodeId);
            pathResult.nodes.forEach(n => connectedNodes.add(n));
            pathResult.links.forEach(l => connectedLinks.add(l));
        }

        node.classed("highlighted", n => connectedNodes.has(n.id))
            .classed("dimmed", n => !connectedNodes.has(n.id));

        const connectedLinkKeys = new Set();
        connectedLinks.forEach(l => {
            const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
            const targetId = typeof l.target === 'object' ? l.target.id : l.target;
            connectedLinkKeys.add(`${sourceId}|${targetId}`);
        });

        svg.selectAll(".link")
            .classed("highlighted", l => {
                const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
                const targetId = typeof l.target === 'object' ? l.target.id : l.target;
                return connectedLinkKeys.has(`${sourceId}|${targetId}`);
            })
            .classed("dimmed", l => {
                const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
                const targetId = typeof l.target === 'object' ? l.target.id : l.target;
                return !connectedLinkKeys.has(`${sourceId}|${targetId}`);
            });
    }

    // If a node was selected, restore its highlight after a short delay
    // to ensure DOM is fully updated
    if (selectedNode) {
        const selectedNodeData = node.data().find(n => n.id === selectedNode);
        if (selectedNodeData) {
            // Apply immediately and also after a delay to ensure it sticks
            applySelectionHighlights(selectedNode);
            setTimeout(() => applySelectionHighlights(selectedNode), 50);
        }
    }
    
    node.on("click", (event, d) => {
        event.stopPropagation();

        if (selectedNode === d.id && node.isTooltipPinned()) {
            resetHighlight(node, svg);
            node.hideTooltip();
            selectedNode = null;
            State.setSelectedNodeId(null);
            return;
        }

        selectedNode = d.id;
        State.setSelectedNodeId(d.id);
        node.showTooltipPinned(event, d);

        // Apply highlight
        applySelectionHighlights(d.id);

        State.emit('nodeSelected', { nodeId: d.id });
    });
    
    svg.on("click", () => {
        resetHighlight(node, svg);
        node.hideTooltip();
        selectedNode = null;
        State.setSelectedNodeId(null);
    });

    // Listen for restore selection highlight event (e.g., after clearing frontier)
    State.subscribe('restoreSelectionHighlight', () => {
        if (selectedNode) {
            applySelectionHighlights(selectedNode);
        }
    });

    // Listen for path-from-start checkbox changes
    State.subscribe('pathFromStartChanged', () => {
        if (selectedNode) {
            applySelectionHighlights(selectedNode);
        }
    });
}

function resetHighlight(node, svg) {
    node.classed("highlighted", false).classed("dimmed", false);
    svg.selectAll(".link").classed("highlighted", false).classed("dimmed", false);
    
    if (State.isFrontierHighlightActive()) {
        State.emit('frontierHighlightChanged', true);
    }
}

// ============================================================
// SEARCH
// ============================================================

function setupSearch(node, link, allNodes) {
    State.subscribe('searchMatched', ({ matchingIds }) => {
        node.classed("highlighted", n => matchingIds.has(n.id))
            .classed("dimmed", n => !matchingIds.has(n.id));
        link.classed("dimmed", true).classed("highlighted", false);
    });
    
    State.subscribe('searchCleared', () => {
        node.classed("highlighted", false).classed("dimmed", false);
        link.classed("dimmed", false).classed("highlighted", false);
    });
}

// ============================================================
// EVENT SUBSCRIPTIONS
// ============================================================

State.subscribe('nodeTagsUpdated', ({ nodeId, tags }) => {
    // Update node label in graph
    const svg = d3.select("svg");
    const explorationState = State.getExplorationState();
    
    svg.selectAll(".node")
        .filter(d => d.id === nodeId)
        .select("text")
        .text(d => {
            let label = d.id;
            if (tags && tags.length > 0) {
                const emojis = tags.map(tagId => {
                    const tag = State.AVAILABLE_TAGS.find(t => t.id === tagId);
                    return tag ? tag.emoji : '';
                }).filter(e => e).join('');
                label += ' ' + emojis;
            }
            return label;
        });
});
