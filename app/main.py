from __future__ import annotations

import asyncio
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
from urllib.parse import unquote

from fastapi import FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .db import EDITABLE_COLUMNS, UNSET, CellConflict, Database, UnknownFoup
from .live_data import LiveDataAdapter, build_live_adapter, utc_now
from .schemas import BatchPatchRequest, CellPatch


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


def model_values(model: Any) -> Dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_unset=True)
    return model.dict(exclude_unset=True)


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: Set[WebSocket] = set()
        self.lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self.lock:
            self.connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self.lock:
            self.connections.discard(websocket)

    async def broadcast(self, message: Dict[str, Any]) -> None:
        async with self.lock:
            targets = list(self.connections)
        stale: List[WebSocket] = []
        for websocket in targets:
            try:
                await websocket.send_json(message)
            except Exception:
                stale.append(websocket)
        if stale:
            async with self.lock:
                for websocket in stale:
                    self.connections.discard(websocket)


def _validate_patch(data: Dict[str, Any]) -> None:
    if "value" not in data and "color" not in data:
        raise HTTPException(status_code=400, detail="value 또는 color 중 하나가 필요합니다.")
    if "color" in data and data["color"] is not None:
        color = str(data["color"])
        if not HEX_COLOR.fullmatch(color):
            raise HTTPException(status_code=422, detail="색상은 #RRGGBB 형식이어야 합니다.")
        data["color"] = color.upper()


def _actor_name(header_value: Optional[str]) -> str:
    decoded = unquote(header_value or "익명 사용자").strip()
    return decoded[:80] or "익명 사용자"


def _empty_live(foup_id: str, total_slots: int) -> Dict[str, Any]:
    return {
        "foup_id": foup_id,
        "location": "연동 정보 없음",
        "location_type": "UNKNOWN",
        "status": "UNAVAILABLE",
        "synced_at": None,
        "slots": [
            {
                "slot_no": slot_no,
                "wafer_id": None,
                "current_step": None,
                "last_process": None,
                "history_count": 0,
            }
            for slot_no in range(1, total_slots + 1)
        ],
    }


def create_app(
    database_path: Optional[str] = None,
    live_adapter: Optional[LiveDataAdapter] = None,
) -> FastAPI:
    database_target = (
        database_path
        or os.getenv("DATABASE_URL")
        or os.getenv("FOUP_DATABASE_URL")
        or os.getenv("FOUP_DB_PATH")
        or str(BASE_DIR.parent / "data" / "foup_manager.db")
    )
    database = Database(database_target)
    adapter = live_adapter or build_live_adapter()
    manager = ConnectionManager()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database.initialize()
        app.state.database = database
        app.state.live_adapter = adapter
        app.state.connection_manager = manager
        yield

    app = FastAPI(
        title="FOUP Control Sheet",
        version="0.1.0",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/health")
    async def health() -> Dict[str, Any]:
        return {
            "status": "ok",
            "live_mode": adapter.mode,
            "timestamp": utc_now(),
        }

    @app.get("/api/state")
    async def state() -> Dict[str, Any]:
        foups = database.list_foups()
        foup_ids = [item["id"] for item in foups]
        cells = database.list_cells(foup_ids)
        cells_by_slot: Dict[str, Dict[int, Dict[str, Any]]] = {}
        for cell in cells:
            cells_by_slot.setdefault(cell["foup_id"], {}).setdefault(cell["slot_no"], {})[
                cell["column_key"]
            ] = cell

        live_error = None
        try:
            live_snapshot = await adapter.get_snapshot(foup_ids)
        except Exception as exc:
            live_snapshot = {}
            live_error = "실시간 정보 연동에 실패했습니다: {}".format(type(exc).__name__)

        response_foups = []
        occupied_total = 0
        reserved_total = 0
        for foup in foups:
            live = live_snapshot.get(foup["id"]) or _empty_live(
                foup["id"], foup["total_slots"]
            )
            live_slots = {slot["slot_no"]: slot for slot in live.get("slots", [])}
            slots = []
            for slot_no in range(1, foup["total_slots"] + 1):
                slot_cells = cells_by_slot.get(foup["id"], {}).get(slot_no, {})
                normalized_cells = {}
                for column_key in EDITABLE_COLUMNS:
                    normalized_cells[column_key] = slot_cells.get(
                        column_key,
                        {
                            "foup_id": foup["id"],
                            "slot_no": slot_no,
                            "column_key": column_key,
                            "value": "",
                            "color": None,
                            "version": 0,
                            "updated_by": "system",
                            "updated_at": None,
                        },
                    )
                slot_live = live_slots.get(
                    slot_no,
                    {
                        "slot_no": slot_no,
                        "wafer_id": None,
                        "current_step": None,
                        "last_process": None,
                        "history_count": 0,
                    },
                )
                if slot_live.get("wafer_id"):
                    occupied_total += 1
                if any(
                    cell.get("value") or cell.get("color")
                    for cell in normalized_cells.values()
                ):
                    reserved_total += 1
                slots.append(
                    {
                        "slot_no": slot_no,
                        "live": slot_live,
                        "cells": normalized_cells,
                    }
                )
            response_foups.append({**foup, "live": {k: v for k, v in live.items() if k != "slots"}, "slots": slots})

        return {
            "generated_at": utc_now(),
            "live_mode": adapter.mode,
            "live_error": live_error,
            "summary": {
                "foup_count": len(response_foups),
                "occupied_slots": occupied_total,
                "planned_slots": reserved_total,
            },
            "editable_columns": list(EDITABLE_COLUMNS),
            "foups": response_foups,
        }

    @app.patch("/api/cells/{foup_id}/{slot_no}/{column_key}")
    async def patch_cell(
        foup_id: str,
        slot_no: int,
        column_key: str,
        patch: CellPatch,
        x_user: Optional[str] = Header(default=None),
    ) -> Dict[str, Any]:
        if not 1 <= slot_no <= 25:
            raise HTTPException(status_code=422, detail="slot_no는 1~25 범위여야 합니다.")
        if column_key not in EDITABLE_COLUMNS:
            raise HTTPException(status_code=422, detail="수정할 수 없는 열입니다.")
        data = model_values(patch)
        _validate_patch(data)
        updated_by = _actor_name(x_user)
        kwargs = {
            "foup_id": foup_id,
            "slot_no": slot_no,
            "column_key": column_key,
            "value": data.get("value", UNSET),
            "color": data.get("color", UNSET),
            "expected_version": data.get("expected_version"),
            "updated_by": updated_by,
        }
        try:
            result = database.update_cell(**kwargs)
        except UnknownFoup:
            raise HTTPException(status_code=404, detail="FOUP을 찾을 수 없습니다.")
        except CellConflict as exc:
            return JSONResponse(
                status_code=409,
                content={"detail": "다른 사용자가 먼저 수정했습니다.", "current": exc.current},
            )
        await manager.broadcast({"type": "cell_updated", "cell": result})
        return result

    @app.post("/api/cells/batch")
    async def patch_cells(
        payload: BatchPatchRequest,
        x_user: Optional[str] = Header(default=None),
    ) -> Dict[str, Any]:
        updated_by = _actor_name(x_user)
        updates = []
        for item in payload.updates:
            data = model_values(item)
            _validate_patch(data)
            update = {
                "foup_id": data.pop("foup_id"),
                "slot_no": data.pop("slot_no"),
                "column_key": data.pop("column_key"),
                "value": data.get("value", UNSET),
                "color": data.get("color", UNSET),
                "expected_version": data.get("expected_version"),
            }
            updates.append(update)
        try:
            results = database.batch_update(updates, updated_by=updated_by)
        except UnknownFoup:
            raise HTTPException(status_code=404, detail="FOUP을 찾을 수 없습니다.")
        except CellConflict as exc:
            return JSONResponse(
                status_code=409,
                content={"detail": "일괄 수정 중 충돌이 발생했습니다.", "current": exc.current},
            )
        await manager.broadcast({"type": "cells_updated", "cells": results})
        return {"updated": len(results), "cells": results}

    @app.get("/api/foups/{foup_id}/slots/{slot_no}/history")
    async def wafer_history(foup_id: str, slot_no: int) -> Dict[str, Any]:
        if foup_id not in {item["id"] for item in database.list_foups()}:
            raise HTTPException(status_code=404, detail="FOUP을 찾을 수 없습니다.")
        if not 1 <= slot_no <= 25:
            raise HTTPException(status_code=422, detail="slot_no는 1~25 범위여야 합니다.")
        try:
            return await adapter.get_wafer_history(foup_id, slot_no)
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail="Wafer History 연동에 실패했습니다: {}".format(type(exc).__name__),
            )

    @app.get("/api/activity")
    async def activity(limit: int = Query(default=30, ge=1, le=200)) -> Dict[str, Any]:
        return {"items": database.recent_activity(limit)}

    @app.websocket("/ws/updates")
    async def websocket_updates(websocket: WebSocket) -> None:
        await manager.connect(websocket)
        await websocket.send_json({"type": "ready", "timestamp": utc_now()})
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            await manager.disconnect(websocket)
        except Exception:
            await manager.disconnect(websocket)

    return app


app = create_app()
