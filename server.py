#!/usr/bin/env python3
"""
Fog Gate Visualizer - Sync Server

Minimal WebSocket server for real-time synchronization between host and viewers.
Sessions are in-memory only (no persistence needed - sessions are ephemeral).

Usage:
    pip install fastapi uvicorn websockets
    python server.py [--port 8001]

    Or with uvicorn directly:
    uvicorn server:app --host 0.0.0.0 --port 8001 --reload
"""

import argparse
import random
import string
from dataclasses import dataclass, field
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Fog Gate Sync Server")


# =============================================================================
# Session Management
# =============================================================================

@dataclass
class Session:
    code: str
    host: Optional[WebSocket] = None
    viewers: list[WebSocket] = field(default_factory=list)
    state: dict = field(default_factory=dict)


sessions: dict[str, Session] = {}


def generate_code() -> str:
    """Generate a unique 4-character session code."""
    while True:
        code = ''.join(random.choices(string.ascii_uppercase, k=4))
        if code not in sessions:
            return code


# =============================================================================
# WebSocket Handlers
# =============================================================================

@app.websocket("/ws/host")
async def host_connect(websocket: WebSocket):
    """Host creates a new session and broadcasts state updates to viewers."""
    await websocket.accept()

    code = generate_code()
    session = Session(code=code, host=websocket)
    sessions[code] = session

    # Send session code to host
    await websocket.send_json({"type": "session_created", "code": code})

    try:
        while True:
            data = await websocket.receive_json()

            if data.get("type") == "state_update":
                session.state = data.get("state", {})
                # Broadcast to all viewers
                disconnected = []
                for viewer in session.viewers:
                    try:
                        await viewer.send_json({
                            "type": "state_update",
                            "state": session.state
                        })
                    except Exception:
                        disconnected.append(viewer)

                # Clean up disconnected viewers
                for viewer in disconnected:
                    session.viewers.remove(viewer)

    except WebSocketDisconnect:
        pass
    finally:
        # Clean up session when host disconnects
        if code in sessions:
            # Notify viewers that host disconnected
            for viewer in session.viewers:
                try:
                    await viewer.send_json({"type": "host_disconnected"})
                    await viewer.close()
                except Exception:
                    pass
            del sessions[code]


@app.websocket("/ws/viewer/{code}")
async def viewer_connect(websocket: WebSocket, code: str):
    """Viewer joins an existing session and receives state updates."""
    code = code.upper()

    if code not in sessions:
        await websocket.accept()
        await websocket.send_json({"type": "error", "message": "Session not found"})
        await websocket.close()
        return

    session = sessions[code]
    await websocket.accept()
    session.viewers.append(websocket)

    # Send current state immediately
    await websocket.send_json({
        "type": "connected",
        "state": session.state
    })

    try:
        # Keep connection alive, handle any viewer messages if needed
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in session.viewers:
            session.viewers.remove(websocket)


# =============================================================================
# Static Files & Health Check
# =============================================================================

@app.get("/api/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "sessions": len(sessions)}


# Serve static files from src/
app.mount("/", StaticFiles(directory="src", html=True), name="static")


# =============================================================================
# Main
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="Fog Gate Sync Server")
    parser.add_argument("--port", type=int, default=8001, help="Port to listen on")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    args = parser.parse_args()

    print(f"Starting server on http://{args.host}:{args.port}")
    print(f"Open http://localhost:{args.port} in your browser")

    uvicorn.run(app, host=args.host, port=args.port)
