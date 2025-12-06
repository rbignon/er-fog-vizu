# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Elden Ring Fog Gate Randomizer Visualizer - a web-based tool to visualize spoiler logs from the Fog Gate Randomizer mod. Frontend with Python WebSocket backend for streamer sync.

## Running the Application

```bash
pip install -r requirements.txt
python server.py              # FastAPI server on port 8001
python server.py --port 8080  # Custom port
```

Open `http://localhost:8001` in browser. No build step required - ES6 modules run directly.

## Architecture

**State Management** (`src/js/state.js`):
- Centralized state with pub/sub event bus
- `State.subscribe('eventName', callback)` for inter-module communication
- Setters emit events automatically (e.g., `setExplorationMode()` emits `explorationModeChanged`)

**Module Structure**:
- `main.js` - Entry point, orchestration
- `state.js` - Single source of truth + event bus
- `parser.js` - Spoiler log parsing (SpoilerLogParser, ItemLogParser)
- `graph.js` - D3.js force simulation, rendering, interactions
- `ui.js` - File upload, controls, search, modals
- `exploration.js` - Discovery logic, pathfinding, preexisting propagation
- `sync.js` - WebSocket streamer sync (host/viewer modes)

**Backend** (`server.py`):
- FastAPI with WebSocket support
- Serves static files from `src/`
- In-memory session management (no persistence needed)

**Data Flow**: File Upload → Parser → State → Graph Render → UI Events → State Updates → WebSocket Sync

## Key Patterns

**Graph Data**:
- Nodes: `{ id, isBoss, scaling, isHub }`
- Links: `{ source, target, type: 'random'|'preexisting', oneWay, requiredItemFrom }`

**Exploration State**:
- `discovered`: Set of area IDs
- `tags`: Map of area ID → array of tag IDs
- Preexisting connections auto-propagate discoveries

**WebSocket Sync**:
- Host creates session via `/ws/host`, receives 4-char code
- Viewers join via `/ws/viewer/{code}`
- Visual state (CSS classes, positions, viewport) synced in real-time
- Viewer mode: `?viewer=true&session=CODE`
- Classes synced: `highlighted`, `dimmed`, `frontier-highlight`, `access-highlight`

## Important Conventions

- Events that modify DOM visuals should delay `syncToFirebase()` by ~50ms to capture CSS changes
- Viewer never recalculates highlights locally - applies classes received from host
- localStorage persists exploration per seed: `er-fog-exploration-{seed}`
- D3 selections use `.node` and `.link` classes

## Known Pitfalls (WebSocket Sync)

1. **Sync timing**: Events like `nodeSelected`, `frontierHighlightChanged` must wait ~50ms before sync so CSS classes are applied to DOM first

2. **CSS classes to sync**: `highlighted`, `dimmed`, `frontier-highlight`, `access-highlight` - all must be captured in `getFullSyncState()` and applied in `applyVisualClasses()`

3. **Exploration mode**: Must be synced (`explorationMode` in state) otherwise viewer keeps old mode when host changes

4. **No recalculation on viewer**: Viewer applies received classes directly. It must never call `highlightFrontier()` itself - check `State.isStreamerHost()` before any local calculation

## Deployment

- `fog-vizu.service` - systemd unit file
- `fog-vizu.nginx.conf` - nginx reverse proxy config with WebSocket support
