# Elden Ring Fog Gate Randomizer Visualizer

An interactive web-based tool to visualize spoiler logs from the [Fog Gate Randomizer](https://www.nexusmods.com/eldenring/mods/3295) mod for Elden Ring.

![Status](https://img.shields.io/badge/status-active-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

**Try it online:** [https://malenia.win/fog-vizu/](https://malenia.win/fog-vizu/)

## Features

- **Interactive Graph Visualization** - Explore fog gate connections as a force-directed graph powered by D3.js
- **Explorer Mode** - Discover areas progressively as you play, with automatic save/load per seed
- **Full Spoiler Mode** - View the entire randomized map at once
- **Pathfinding** - Click any node to highlight the shortest path from Chapel of Anticipation
- **Frontier Highlighting** - See unexplored areas and their access points at a glance
- **Item Log Integration** - Load Item Randomizer logs to see key item locations on gates
- **Area Tagging** - Mark areas with custom tags for tracking your progress
- **Streamer Sync** - Real-time synchronization between devices, perfect for OBS overlays

## Quick Start

### Requirements

- A modern web browser (Chrome, Firefox, Edge, Safari)
- Python 3 (for local server)
- A spoiler log file from Fog Gate Randomizer

### Running Locally

```bash
# Start the server
./serve.sh

# Or specify a custom port
./serve.sh 8080
```

Open `http://localhost:8000` in your browser.

> **Note:** The application uses ES6 modules, so it must be served over HTTP. Opening `index.html` directly via `file://` won't work.

### Using the Visualizer

1. **Load a spoiler log** - Drag and drop your `spoiler_log.txt` file, or click to browse
2. **Choose your mode**:
   - **Explorer Mode**: Start with only Chapel of Anticipation visible. Click nodes to discover connected areas as you play
   - **Full Spoiler Mode**: See the entire map immediately
3. **Navigate the graph**:
   - Scroll to zoom
   - Drag to pan
   - Click a node to see details and connections
   - Hover over connections to see travel info
4. **Try the demo** - Click "Try Demo" to explore with a sample seed

## Streamer Sync

Perfect for streaming setups where you want the graph displayed on a separate monitor or OBS browser source.

### Setup

1. Click the **Sync** button in the main UI
2. Click **Create Session** to generate a 4-character code
3. On your second device (or OBS browser source), either:
   - Enter the code manually, or
   - Use the generated viewer URL directly

### Viewer Mode

The viewer URL format is:
```
http://localhost:8000/?viewer=true&session=CODE
```

In viewer mode:
- The UI is minimal (no controls)
- All interactions are mirrored from the host in real-time
- Viewport position and zoom are synchronized

## Technical Details

- **Pure Frontend** - No build step required, ES6 modules run directly in browser
- **D3.js** - Force-directed graph simulation for automatic layout
- **Firebase Realtime Database** - Powers the streamer sync feature
- **LocalStorage** - Persists exploration progress per seed

## Browser Support

Tested on:
- Chrome 90+
- Firefox 88+
- Edge 90+
- Safari 14+

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [thefifthmatt](https://www.nexusmods.com/eldenring/users/58426171) for creating the Fog Gate Randomizer mod
- [D3.js](https://d3js.org/) for the visualization library
