# Elden Ring Fog Gate Randomizer Visualizer

An interactive web-based tool to visualize spoiler logs from the [Fog Gate Randomizer](https://www.nexusmods.com/eldenring/mods/3295) mod for Elden Ring.

![Status](https://img.shields.io/badge/status-active-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

**Try it online:** [https://fogvizu.malenia.win](https://fogvizu.malenia.win)

## Features

- **Interactive Graph Visualization** - Explore fog gate connections as a force-directed graph powered by D3.js
- **Explorer Mode** - Discover areas progressively as you play, with automatic save/load per seed
- **Full Spoiler Mode** - View the entire randomized map at once
- **Pathfinding** - Click any node to highlight the shortest path from Chapel of Anticipation
- **Frontier Highlighting** - See unexplored areas and their access points at a glance
- **Item Log Integration** - Load Item Randomizer logs to see key item locations on gates
- **Area Tagging** - Mark areas with custom tags for tracking your progress
- **Stream to OBS** - Real-time synchronization via WebSocket for OBS browser sources

## Quick Start

### Requirements

- A modern web browser (Chrome, Firefox, Edge, Safari)
- Python 3.10+ (for local server)
- A spoiler log file from Fog Gate Randomizer

### Running Locally

```bash
# Clone the repository
git clone https://github.com/rbignon/er-fog-vizu.git
cd er-fog-vizu

# Install dependencies
pip install -r requirements.txt

# Start the server
python server.py

# Or specify a custom port
python server.py --port 8080
```

Open `http://localhost:8001` in your browser.

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

## Stream to OBS

Display the graph on your stream with real-time synchronization.

### Setup

1. Click the **Stream** button in the main UI
2. Click **Start Session** to create a streaming session
3. Copy the generated URL
4. In OBS:
   - Click **+** under Sources
   - Select **Browser**
   - Paste the URL
   - Set dimensions to **1920 x 1080** (or your canvas size)

The browser source will mirror your interactions in real-time: navigation, zoom, node selection, and exploration progress.

## Deployment

### Systemd service

```bash
sudo cp fog-vizu.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fog-vizu
```

### Nginx reverse proxy

Include `fog-vizu.nginx.conf` in your nginx server block. WebSocket support is configured.

## Technical Details

- **Pure Frontend** - No build step required, ES6 modules run directly in browser
- **FastAPI + WebSocket** - Python backend for real-time streamer sync
- **D3.js** - Force-directed graph simulation for automatic layout
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
