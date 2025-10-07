import json
import hmac
import hashlib
import asyncio
import logging
import os
import uuid
from datetime import datetime, timedelta
from urllib.parse import parse_qs, unquote as url_unquote
from typing import Dict, List, Optional, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

log_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
log_handler = logging.FileHandler("webrtc_server.log")
log_handler.setFormatter(log_formatter)
console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
logger.addHandler(log_handler)
logger.addHandler(console_handler)

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

HISTORY_DIR = "history"
LOGS_DIR = "logs"
MAX_HISTORY_ENTRIES = 50
PRIVATE_ROOM_LIFETIME_HOURS = 3

class ClientLog(BaseModel):
    user_id: str
    room_id: str
    message: str

class CreateRoomRequest(BaseModel):
    user_id: int

class CallLogEntry(BaseModel):
    user: Dict[str, Any]
    type: str
    direction: str
    timestamp: str
    status: str
    duration: Optional[str] = None

class RoomManager:
    def __init__(self, room_id: str, is_private: bool = False, max_users: Optional[int] = None):
        self.room_id = room_id
        self.is_private = is_private
        self.max_users = max_users
        self.active_connections: Dict[Any, WebSocket] = {}
        self.users: Dict[Any, dict] = {}
        self.call_timeouts: Dict[tuple, asyncio.Task] = {}

    async def connect(self, websocket: WebSocket, user_id: Any, user_data: dict):
        if self.max_users is not None and len(self.active_connections) >= self.max_users:
            logger.warning(f"Room {self.room_id} is full. Rejecting user {user_id}.")
            await websocket.close(code=1008, reason="Room is full")
            return False

        await websocket.accept()

        # For private rooms, send the server-assigned ID back to the client
        if self.is_private:
            await websocket.send_json({"type": "identity", "data": {"id": user_id}})

        self.active_connections[user_id] = websocket
        self.users[user_id] = {**user_data, "status": "available"}
        logger.info(f"User {user_id} ({user_data.get('first_name', 'Anonymous')}) connected to room {self.room_id}.")
        await self.broadcast_user_list()
        return True

    def disconnect(self, user_id: Any):
        if user_id in self.active_connections:
            del self.active_connections[user_id]
        if user_id in self.users:
            del self.users[user_id]
        logger.info(f"User {user_id} disconnected from room {self.room_id}.")

    async def broadcast_user_list(self):
        user_list = list(self.users.values())
        message = {"type": "user_list", "data": user_list}
        connections = list(self.active_connections.values())
        for connection in connections:
            try:
                await connection.send_json(message)
            except Exception as e:
                logger.warning(f"Could not send user_list to a client in room {self.room_id}: {e}")


    async def broadcast_message(self, message: dict):
        connections = list(self.active_connections.values())
        for connection in connections:
            try:
                await connection.send_json(message)
            except Exception as e:
                logger.warning(f"Could not broadcast message to a client in room {self.room_id}: {e}")

    async def send_personal_message(self, message: dict, user_id: Any):
        if user_id in self.active_connections:
            try:
                await self.active_connections[user_id].send_json(message)
            except Exception as e:
                logger.warning(f"Could not send personal message to {user_id} in room {self.room_id}: {e}")

    async def set_user_status(self, user_id: Any, status: str):
        if user_id in self.users:
            self.users[user_id]["status"] = status
            await self.broadcast_user_list()

    async def _call_timeout_task(self, caller_id: Any, target_id: Any):
        await asyncio.sleep(60)
        call_key = tuple(sorted((caller_id, target_id)))
        if call_key in self.call_timeouts:
            logger.warning(f"Call from {caller_id} to {target_id} timed out.")
            del self.call_timeouts[call_key]
            await self.send_personal_message({"type": "call_missed"}, caller_id)
            await self.send_personal_message({"type": "call_ended"}, target_id)
            await self.set_user_status(caller_id, "available")
            await self.set_user_status(target_id, "available")

    def start_call_timeout(self, caller_id: Any, target_id: Any):
        call_key = tuple(sorted((caller_id, target_id)))
        self.cancel_call_timeout(caller_id, target_id)
        task = asyncio.create_task(self._call_timeout_task(caller_id, target_id))
        self.call_timeouts[call_key] = task

    def cancel_call_timeout(self, user1_id: Any, user2_id: Any):
        call_key = tuple(sorted((user1_id, user2_id)))
        if call_key in self.call_timeouts:
            self.call_timeouts[call_key].cancel()
            del self.call_timeouts[call_key]

class ConnectionManager:
    def __init__(self):
        self.rooms: Dict[str, RoomManager] = {}
        self.private_room_cleanup_tasks: Dict[str, asyncio.Task] = {}

    def get_or_create_room(self, room_id: str, is_private: bool = False) -> RoomManager:
        if room_id not in self.rooms:
            max_users = 2 if is_private else None
            self.rooms[room_id] = RoomManager(room_id, is_private=is_private, max_users=max_users)
            logger.info(f"Created new {'private' if is_private else 'public'} room: {room_id}")
        return self.rooms[room_id]

    async def schedule_private_room_cleanup(self, room_id: str, delay_hours: int):
        cleanup_task = asyncio.create_task(self._cleanup_room_after_delay(room_id, delay_hours))
        self.private_room_cleanup_tasks[room_id] = cleanup_task
        logger.info(f"Scheduled cleanup for private room {room_id} in {delay_hours} hours.")

    async def _cleanup_room_after_delay(self, room_id: str, delay_hours: int):
        await asyncio.sleep(delay_hours * 3600)
        if room_id in self.rooms:
            room = self.rooms[room_id]
            logger.warning(f"Lifetime expired for private room {room_id}. Terminating connections.")
            await room.broadcast_message({"type": "room_expired"})
            user_ids = list(room.active_connections.keys())
            for user_id in user_ids:
                websocket = room.active_connections.get(user_id)
                if websocket:
                    await websocket.close(code=1000, reason="Room lifetime expired")
                room.disconnect(user_id)

            del self.rooms[room_id]
            logger.info(f"Private room {room_id} has been cleaned up and deleted.")
        if room_id in self.private_room_cleanup_tasks:
            del self.private_room_cleanup_tasks[room_id]

manager = ConnectionManager()

def validate_init_data(init_data: str) -> Optional[dict]:
    bot_token = os.environ.get("BOT_TOKEN")
    if not bot_token:
        logger.error("BOT_TOKEN not set, cannot validate init data.")
        return None
    try:
        parsed_data = parse_qs(init_data)
        hash_from_telegram = parsed_data.pop('hash')[0]
        data_check_string = "\n".join(f"{k}={v[0]}" for k, v in sorted(parsed_data.items()))
        secret_key = hmac.new("WebAppData".encode(), bot_token.encode(), hashlib.sha256).digest()
        calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        if calculated_hash == hash_from_telegram:
            user_data = json.loads(parsed_data.get('user', ['{}'])[0])
            return user_data
        logger.warning("Init data validation failed: hash mismatch.")
        return None
    except Exception as e:
        logger.error(f"Exception during init data validation: {e}")
        return None

@app.on_event("startup")
async def startup_event():
    os.makedirs(HISTORY_DIR, exist_ok=True)
    os.makedirs(LOGS_DIR, exist_ok=True)

@app.post("/log")
async def receive_log(log: ClientLog):
    try:
        log_file_path = os.path.join(LOGS_DIR, f"{log.room_id}.log")
        with open(log_file_path, "a", encoding="utf-8") as f:
            f.write(f"[{log.user_id}] {log.message}\n")
        return JSONResponse(content={"status": "logged"}, status_code=200)
    except Exception as e:
        logger.error(f"Failed to write client log to file: {e}")
        return JSONResponse(content={"status": "error", "detail": str(e)}, status_code=500)

@app.post("/create_private_room")
async def create_private_room(request: Request, data: CreateRoomRequest):
    room_id = str(uuid.uuid4())
    web_app_url = os.environ.get("WEB_APP_URL", "http://localhost:8000")
    if not web_app_url.endswith('/'):
        web_app_url += '/'

    full_link = f"{web_app_url}call/{room_id}"

    send_message_func = request.app.state.send_message_function
    success = await send_message_func(chat_id=data.user_id, link=full_link)

    if success:
        manager.get_or_create_room(room_id, is_private=True)
        await manager.schedule_private_room_cleanup(room_id, PRIVATE_ROOM_LIFETIME_HOURS)
        return JSONResponse({"status": "ok", "room_id": room_id, "link": full_link})
    else:
        raise HTTPException(status_code=500, detail="Failed to send message via Telegram Bot")

@app.get("/history/{encoded_init_data}")
async def get_history(encoded_init_data: str):
    init_data = url_unquote(encoded_init_data)
    user_data = validate_init_data(init_data)
    if not user_data:
        raise HTTPException(status_code=403, detail="Forbidden")

    user_id = user_data['id']
    history_file = os.path.join(HISTORY_DIR, f"{user_id}.json")

    if not os.path.exists(history_file):
        return []

    try:
        with open(history_file, "r", encoding="utf-8") as f:
            history = json.load(f)
        return history
    except (json.JSONDecodeError, IOError) as e:
        logger.error(f"Could not read or parse history for user {user_id}: {e}")
        return []

@app.post("/history/{encoded_init_data}")
async def save_history(encoded_init_data: str, call_log: CallLogEntry):
    init_data = url_unquote(encoded_init_data)
    user_data = validate_init_data(init_data)
    if not user_data:
        raise HTTPException(status_code=403, detail="Forbidden")

    user_id = user_data['id']
    history_file = os.path.join(HISTORY_DIR, f"{user_id}.json")

    history = []
    if os.path.exists(history_file):
        try:
            with open(history_file, "r", encoding="utf-8") as f:
                history = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass 

    history.insert(0, call_log.dict())
    history = history[:MAX_HISTORY_ENTRIES]

    try:
        with open(history_file, "w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
        return {"status": "ok"}
    except IOError as e:
        logger.error(f"Could not write history for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Could not save history")

@app.get("/{path:path}", response_class=HTMLResponse)
async def get_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

async def handle_websocket_logic(websocket: WebSocket, room: RoomManager, user_id: Any):
    try:
        while True:
            message = await websocket.receive_json()
            message_type = message.get("type")

            if message_type == "call_user":
                target_id = message["data"]["target_id"]
                call_type = message["data"]["call_type"]
                await room.set_user_status(user_id, "busy")
                await room.set_user_status(target_id, "busy")
                await room.send_personal_message(
                    {"type": "incoming_call", "data": {
                        "from": user_id,
                        "from_user": room.users[user_id],
                        "call_type": call_type
                    }},
                    target_id
                )
                room.start_call_timeout(user_id, target_id)

            elif message_type == "call_accepted":
                target_id = message["data"]["target_id"]
                room.cancel_call_timeout(user_id, target_id)
                await room.send_personal_message(
                    {"type": "call_accepted", "data": {"from": user_id}},
                    target_id
                )

            elif message_type in ["offer", "answer", "candidate"]:
                target_id = message["data"]["target_id"]
                message["data"]["from"] = user_id
                await room.send_personal_message(message, target_id)

            elif message_type in ["hangup", "call_declined"]:
                target_id = message["data"]["target_id"]
                room.cancel_call_timeout(user_id, target_id)
                await room.send_personal_message({"type": "call_ended"}, target_id)
                await room.set_user_status(user_id, "available")
                await room.set_user_status(target_id, "available")

    except WebSocketDisconnect:
        for key in list(room.call_timeouts.keys()):
            if user_id in key:
                other_user_id = key[0] if key[1] == user_id else key[1]
                logger.warning(f"User {user_id} disconnected during a call with {other_user_id}. Terminating call.")
                room.cancel_call_timeout(user_id, other_user_id)
                await room.send_personal_message({"type": "call_ended"}, other_user_id)
                await room.set_user_status(other_user_id, "available")
        room.disconnect(user_id)
        await room.broadcast_user_list()
    except Exception as e:
        logger.error(f"An unexpected error occurred for user {user_id}: {e}")
        room.disconnect(user_id)
        await room.broadcast_user_list()

@app.websocket("/ws/tg/{chat_id}/{encoded_init_data}")
async def websocket_endpoint_tg(websocket: WebSocket, chat_id: str, encoded_init_data: str):
    init_data = url_unquote(encoded_init_data)
    user_data = validate_init_data(init_data)
    if not user_data:
        await websocket.close(code=1008, reason="Forbidden: Invalid initData")
        return

    user_id = user_data['id']
    logger.info(f"User {user_id} passed validation for TG room {chat_id}.")
    room = manager.get_or_create_room(chat_id)

    connected = await room.connect(websocket, user_id, user_data)
    if connected:
        await handle_websocket_logic(websocket, room, user_id)

@app.websocket("/ws/private/{room_id}")
async def websocket_endpoint_private(websocket: WebSocket, room_id: str):
    if room_id not in manager.rooms or not manager.rooms[room_id].is_private:
        await websocket.close(code=1008, reason="Forbidden: Room not found or not private")
        return

    user_id = str(uuid.uuid4())
    user_data = {"id": user_id, "first_name": "Собеседник", "last_name": ""}

    room = manager.get_or_create_room(room_id, is_private=True)

    connected = await room.connect(websocket, user_id, user_data)
    if connected:
        await handle_websocket_logic(websocket, room, user_id)
