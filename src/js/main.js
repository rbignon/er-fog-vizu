// ============================================================
// MAIN - Application entry point and orchestration
// ============================================================

import * as State from './state.js';
import * as UI from './ui.js';
import * as Graph from './graph.js';
import * as Sync from './sync.js';

// ============================================================
// INITIALIZATION
// ============================================================

async function init() {
    console.log('Initializing application...');

    // Initialize sync module
    Sync.initSync();
    Sync.setupViewerMode();

    // Initialize UI event listeners
    UI.initUI();

    // Initialize stream modal UI
    Sync.initStreamUI();
    
    // Subscribe to graph render events
    State.subscribe('graphNeedsRender', ({ preservePositions, centerOnNodeId }) => {
        Graph.renderGraph(preservePositions);

        // Center on discovered node after render stabilizes
        if (centerOnNodeId) {
            setTimeout(() => {
                Graph.centerOnNode(centerOnNodeId);
            }, 300);
        }
    });
    
    console.log('Application initialized');
}

// ============================================================
// START APPLICATION
// ============================================================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
