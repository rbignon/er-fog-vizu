# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Elden Ring Fog Gate Randomizer Visualizer - a web-based tool to visualize spoiler logs from the Fog Gate Randomizer mod. Pure frontend with optional Firebase sync for streamers.

## Running the Application

```bash
./serve.sh              # Python HTTP server on port 8000
./serve.sh 8080         # Custom port
node serve.js           # Node.js alternative
```

Open `http://localhost:8000` in browser. No build step required - ES6 modules run directly.

## Architecture

**State Management** (`js/state.js`):
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
- `firebase.js` - Streamer sync (host/viewer modes)

**Data Flow**: File Upload → Parser → State → Graph Render → UI Events → State Updates → Firebase Sync

## Key Patterns

**Graph Data**:
- Nodes: `{ id, isBoss, scaling, isHub }`
- Links: `{ source, target, type: 'random'|'preexisting', oneWay, requiredItemFrom }`

**Exploration State**:
- `discovered`: Set of area IDs
- `tags`: Map of area ID → array of tag IDs
- Preexisting connections auto-propagate discoveries

**Firebase Sync**:
- Host creates session, viewers join with code
- Visual state (CSS classes, positions, viewport) synced in real-time
- Viewer mode: `?viewer=true&session=CODE`
- Classes synced: `highlighted`, `dimmed`, `frontier-highlight`, `access-highlight`

## Important Conventions

- Events that modify DOM visuals should delay `syncToFirebase()` by ~50ms to capture CSS changes
- Viewer never recalculates highlights locally - applies classes received from host
- localStorage persists exploration per seed: `er-fog-exploration-{seed}`
- D3 selections use `.node` and `.link` classes

## Pièges connus (Firebase Sync)

1. **Timing du sync** : Les événements comme `nodeSelected`, `frontierHighlightChanged` doivent attendre ~50ms avant de sync pour que les classes CSS soient appliquées au DOM

2. **Classes CSS à synchroniser** : `highlighted`, `dimmed`, `frontier-highlight`, `access-highlight` - toutes doivent être capturées dans `getFullSyncState()` et appliquées dans `applyVisualClasses()`

3. **Mode exploration** : Doit être synchronisé (`explorationMode` dans l'état Firebase) sinon le viewer garde l'ancien mode quand l'hôte change

4. **Pas de recalcul côté viewer** : Le viewer applique les classes reçues directement. Il ne doit jamais appeler `highlightFrontier()` lui-même - vérifier `State.isStreamerHost()` avant tout calcul local
