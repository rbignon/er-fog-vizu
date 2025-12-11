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
import asyncio
import random
import string
import time
from dataclasses import dataclass, field
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Fog Gate Sync Server")

# How long to keep orphan sessions (seconds)
ORPHAN_SESSION_TTL = 300  # 5 minutes

# Heartbeat settings
HEARTBEAT_INTERVAL = 15  # Send ping every 15 seconds
HEARTBEAT_TIMEOUT = 10   # Wait 10 seconds for pong response


# =============================================================================
# Session Management
# =============================================================================

@dataclass
class Session:
    code: str
    host: Optional[WebSocket] = None
    viewers: list[WebSocket] = field(default_factory=list)
    state: dict = field(default_factory=dict)
    orphaned_at: Optional[float] = None  # Timestamp when host disconnected


sessions: dict[str, Session] = {}


def generate_code() -> str:
    """Generate a unique 4-character session code."""
    while True:
        code = ''.join(random.choices(string.ascii_uppercase, k=4))
        if code not in sessions:
            return code


async def cleanup_orphan_sessions():
    """Background task to clean up expired orphan sessions."""
    while True:
        await asyncio.sleep(60)  # Check every minute
        now = time.time()
        expired = [
            code for code, session in sessions.items()
            if session.orphaned_at and (now - session.orphaned_at) > ORPHAN_SESSION_TTL
        ]
        for code in expired:
            session = sessions.pop(code, None)
            if session:
                # Notify remaining viewers
                for viewer in session.viewers:
                    try:
                        await viewer.send_json({"type": "session_expired"})
                        await viewer.close()
                    except Exception:
                        pass


@app.on_event("startup")
async def startup():
    asyncio.create_task(cleanup_orphan_sessions())


# =============================================================================
# WebSocket Handlers
# =============================================================================

async def handle_host_session(websocket: WebSocket, session: Session, is_resume: bool):
    """Common handler for host connections (new or resumed)."""
    session.host = websocket
    session.orphaned_at = None  # Clear orphan status
    last_pong = time.time()

    # Send confirmation to host
    await websocket.send_json({
        "type": "session_resumed" if is_resume else "session_created",
        "code": session.code
    })

    # If resuming, notify viewers that host is back
    if is_resume:
        for viewer in session.viewers:
            try:
                await viewer.send_json({"type": "host_reconnected"})
            except Exception:
                pass

    async def heartbeat_task():
        """Send periodic pings to detect dead connections."""
        nonlocal last_pong
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            # Check if we received a pong recently
            if time.time() - last_pong > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT:
                print(f"Host heartbeat timeout for session {session.code}")
                await websocket.close()
                return
            try:
                await websocket.send_json({"type": "ping"})
            except Exception:
                return

    heartbeat = asyncio.create_task(heartbeat_task())

    try:
        while True:
            data = await websocket.receive_json()

            # Handle pong responses
            if data.get("type") == "pong":
                last_pong = time.time()
                continue

            if data.get("type") == "state_update":
                last_pong = time.time()  # Any message counts as activity
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
    except Exception as e:
        print(f"Host session error: {e}")
    finally:
        heartbeat.cancel()
        # Mark session as orphaned instead of deleting
        session.host = None
        session.orphaned_at = time.time()

        # Notify viewers that host disconnected (but session still alive)
        for viewer in session.viewers:
            try:
                await viewer.send_json({"type": "host_disconnected"})
            except Exception:
                pass


@app.websocket("/ws/host")
async def host_connect(websocket: WebSocket):
    """Host creates a new session."""
    await websocket.accept()

    code = generate_code()
    session = Session(code=code)
    sessions[code] = session

    await handle_host_session(websocket, session, is_resume=False)


@app.websocket("/ws/host/{code}")
async def host_resume(websocket: WebSocket, code: str):
    """Host resumes an existing session or recreates it with the same code."""
    code = code.upper()

    if code not in sessions:
        # Session doesn't exist (server restarted) - recreate with same code
        await websocket.accept()
        session = Session(code=code)
        sessions[code] = session
        await handle_host_session(websocket, session, is_resume=True)
        return

    session = sessions[code]

    # Check if session already has an active host
    if session.host is not None:
        await websocket.accept()
        await websocket.send_json({"type": "error", "message": "Session already has a host"})
        await websocket.close()
        return

    await websocket.accept()
    await handle_host_session(websocket, session, is_resume=True)


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
    last_pong = time.time()

    # Send current state immediately
    await websocket.send_json({
        "type": "connected",
        "state": session.state,
        "host_connected": session.host is not None
    })

    async def heartbeat_task():
        """Send periodic pings to detect dead viewer connections."""
        nonlocal last_pong
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            if time.time() - last_pong > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT:
                print(f"Viewer heartbeat timeout for session {code}")
                await websocket.close()
                return
            try:
                await websocket.send_json({"type": "ping"})
            except Exception:
                return

    heartbeat = asyncio.create_task(heartbeat_task())

    try:
        # Keep connection alive, handle viewer messages
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "pong":
                last_pong = time.time()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        heartbeat.cancel()
        if websocket in session.viewers:
            session.viewers.remove(websocket)


# =============================================================================
# Static Files & Health Check
# =============================================================================

@app.get("/api/health")
async def health():
    """Health check endpoint."""
    active = sum(1 for s in sessions.values() if s.host is not None)
    orphaned = len(sessions) - active
    return {"status": "ok", "sessions": len(sessions), "active": active, "orphaned": orphaned}


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
