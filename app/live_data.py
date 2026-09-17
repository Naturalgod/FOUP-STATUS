from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

import httpx


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class LiveDataAdapter:
    """사내 FOUP 정보 시스템이 구현해야 하는 최소 계약."""

    mode = "unknown"

    async def get_snapshot(self, foup_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
        raise NotImplementedError

    async def get_wafer_history(self, foup_id: str, slot_no: int) -> Dict[str, Any]:
        raise NotImplementedError


class DemoLiveDataAdapter(LiveDataAdapter):
    """회사망 밖에서도 화면과 연동 계약을 검증할 수 있는 결정적 데모 데이터."""

    mode = "demo"

    LOCATIONS = {
        "ENG10000": ("FAB 1 · STK-03", "STOCKER"),
        "ENG20002": ("FAB 2 · ALD-120 LP2", "EQUIPMENT"),
        "COM51235": ("R&D BAY · STK-07", "STOCKER"),
        "ENG51235": ("METROLOGY · BF-04", "BUFFER"),
    }
    OCCUPIED = {
        "ENG10000": 10,
        "ENG20002": 10,
        "COM51235": 16,
        "ENG51235": 22,
    }

    @staticmethod
    def _wafer_id(foup_id: str, slot_no: int) -> str:
        if foup_id == "ENG20002":
            return "R7QAA03.{:02d}".format(slot_no)
        prefixes = {
            "ENG10000": "RCM24A",
            "COM51235": "TST2B",
            "ENG51235": "DMO9C",
        }
        return "{}-{:02d}".format(prefixes.get(foup_id, "WFR"), slot_no)

    @staticmethod
    def _step(foup_id: str, slot_no: int) -> str:
        if foup_id == "ENG10000":
            return "RECLAIM CLEAN" if slot_no <= 4 else "TH-OX READY"
        if foup_id == "ENG20002":
            return "ALD W 120" if slot_no <= 3 else "PNL XT" if slot_no <= 6 else "PNL"
        if foup_id == "COM51235":
            return "PTCL REVIEW"
        return "DEMO HOLD"

    async def get_snapshot(self, foup_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
        synced_at = utc_now()
        snapshot: Dict[str, Dict[str, Any]] = {}
        for foup_id in foup_ids:
            location, location_type = self.LOCATIONS.get(foup_id, ("위치 미확인", "UNKNOWN"))
            occupied = self.OCCUPIED.get(foup_id, 0)
            slots = []
            for slot_no in range(1, 26):
                has_wafer = slot_no <= occupied
                slots.append(
                    {
                        "slot_no": slot_no,
                        "wafer_id": self._wafer_id(foup_id, slot_no) if has_wafer else None,
                        "current_step": self._step(foup_id, slot_no) if has_wafer else None,
                        "last_process": "PASS" if has_wafer else None,
                        "history_count": 4 if has_wafer else 0,
                    }
                )
            snapshot[foup_id] = {
                "foup_id": foup_id,
                "location": location,
                "location_type": location_type,
                "status": "ONLINE",
                "synced_at": synced_at,
                "slots": slots,
            }
        return snapshot

    async def get_wafer_history(self, foup_id: str, slot_no: int) -> Dict[str, Any]:
        occupied = self.OCCUPIED.get(foup_id, 0)
        if slot_no > occupied:
            return {
                "foup_id": foup_id,
                "slot_no": slot_no,
                "wafer_id": None,
                "history": [],
            }
        wafer_id = self._wafer_id(foup_id, slot_no)
        now = datetime.now(timezone.utc)
        steps = [
            ("LOT IN", "STK-01", "PASS", 310),
            ("WAFER SORT", "SORT-08", "PASS", 190),
            ("PRE CLEAN", "CLN-14", "PASS", 75),
            (self._step(foup_id, slot_no), "CURRENT", "RUN", 8),
        ]
        history: List[Dict[str, Any]] = []
        for step, tool, result, minutes_ago in steps:
            history.append(
                {
                    "timestamp": (now - timedelta(minutes=minutes_ago)).isoformat(timespec="seconds"),
                    "step": step,
                    "tool": tool,
                    "result": result,
                }
            )
        return {
            "foup_id": foup_id,
            "slot_no": slot_no,
            "wafer_id": wafer_id,
            "history": history,
        }


class HttpLiveDataAdapter(LiveDataAdapter):
    """사내 API를 위한 얇은 HTTP 어댑터.

    GET /foups/snapshot?ids=A,B -> {"foups": [...]}
    GET /foups/{id}/slots/{slot}/history -> history 응답
    """

    mode = "company-api"

    def __init__(self, base_url: str, token: Optional[str] = None, timeout: float = 5.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        if not self.token:
            return {}
        return {"Authorization": "Bearer {}".format(self.token)}

    async def get_snapshot(self, foup_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                "{}/foups/snapshot".format(self.base_url),
                params={"ids": ",".join(foup_ids)},
                headers=self._headers(),
            )
            response.raise_for_status()
            body = response.json()
        foups = body.get("foups", [])
        return {item["foup_id"]: item for item in foups}

    async def get_wafer_history(self, foup_id: str, slot_no: int) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                "{}/foups/{}/slots/{}/history".format(self.base_url, foup_id, slot_no),
                headers=self._headers(),
            )
            response.raise_for_status()
            return response.json()


def build_live_adapter() -> LiveDataAdapter:
    base_url = os.getenv("FOUP_LIVE_API_URL")
    if not base_url:
        return DemoLiveDataAdapter()
    return HttpLiveDataAdapter(
        base_url=base_url,
        token=os.getenv("FOUP_LIVE_API_TOKEN"),
        timeout=float(os.getenv("FOUP_LIVE_API_TIMEOUT", "5")),
    )

