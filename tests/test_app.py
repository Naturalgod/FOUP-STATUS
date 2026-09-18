import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote

from fastapi.testclient import TestClient

from app.live_data import DemoLiveDataAdapter
from app.main import create_app


class FoupAppTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = str(Path(self.temp_dir.name) / "test.db")
        self.client_context = TestClient(
            create_app(database_path=database_path, live_adapter=DemoLiveDataAdapter())
        )
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.temp_dir.cleanup()

    def test_health_and_seeded_sheet_state(self) -> None:
        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["live_mode"], "demo")

        response = self.client.get("/api/state")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["summary"]["foup_count"], 4)
        self.assertEqual([foup["id"] for foup in body["foups"]], [
            "ENG10000",
            "ENG20002",
            "COM51235",
            "ENG51235",
        ])
        self.assertEqual(body["foups"][0]["slots"][0]["cells"]["assignee"]["value"], "김철수")
        self.assertEqual(len(body["foups"][0]["slots"]), 25)

    def test_root_exposes_sheet_and_live_view_controls(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("계획 시트", response.text)
        self.assertIn("실시간 통합", response.text)
        self.assertIn("연두색 셀", response.text)
        self.assertIn("복사·붙여넣기", response.text)
        self.assertIn("내용 지우기", response.text)
        self.assertIn("이 파일은 FastAPI 서버로 열어야 합니다", response.text)

    def test_batch_clear_values_preserves_cell_color(self) -> None:
        color = self.client.patch(
            "/api/cells/ENG10000/1/planned_sub",
            json={"color": "#FFF2CC", "expected_version": 0},
        )
        self.assertEqual(color.status_code, 200)

        clear = self.client.post(
            "/api/cells/batch",
            headers={"X-User": quote("삭제 테스트")},
            json={
                "updates": [
                    {
                        "foup_id": "ENG10000",
                        "slot_no": 1,
                        "column_key": "planned_sub",
                        "value": "",
                        "expected_version": 1,
                    },
                    {
                        "foup_id": "ENG10000",
                        "slot_no": 1,
                        "column_key": "assignee",
                        "value": "",
                        "expected_version": 0,
                    },
                ]
            },
        )
        self.assertEqual(clear.status_code, 200)
        cells = clear.json()["cells"]
        self.assertEqual([cell["value"] for cell in cells], ["", ""])
        self.assertEqual(cells[0]["color"], "#FFF2CC")
        self.assertEqual(cells[0]["updated_by"], "삭제 테스트")

    def test_direct_cell_edit_and_optimistic_conflict(self) -> None:
        response = self.client.patch(
            "/api/cells/ENG10000/11/assignee",
            headers={"X-User": quote("공정개발팀")},
            json={"value": "홍길동", "expected_version": 0},
        )
        self.assertEqual(response.status_code, 200)
        saved = response.json()
        self.assertEqual(saved["value"], "홍길동")
        self.assertEqual(saved["version"], 1)
        self.assertEqual(saved["updated_by"], "공정개발팀")

        conflict = self.client.patch(
            "/api/cells/ENG10000/11/assignee",
            headers={"X-User": quote("다른 사용자")},
            json={"value": "충돌값", "expected_version": 0},
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["current"]["value"], "홍길동")

    def test_batch_color_update_and_color_clear(self) -> None:
        updates = [
            {
                "foup_id": "ENG20002",
                "slot_no": slot,
                "column_key": "details",
                "color": "#fff2cc",
                "expected_version": 0,
            }
            for slot in (11, 12, 13)
        ]
        response = self.client.post(
            "/api/cells/batch",
            headers={"X-User": quote("예약자")},
            json={"updates": updates},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["updated"], 3)
        self.assertTrue(all(cell["color"] == "#FFF2CC" for cell in body["cells"]))

        clear = self.client.patch(
            "/api/cells/ENG20002/11/details",
            json={"color": None, "expected_version": 1},
        )
        self.assertEqual(clear.status_code, 200)
        self.assertIsNone(clear.json()["color"])

    def test_wafer_history_and_activity_log(self) -> None:
        history = self.client.get("/api/foups/ENG20002/slots/1/history")
        self.assertEqual(history.status_code, 200)
        self.assertEqual(history.json()["wafer_id"], "R7QAA03.01")
        self.assertGreaterEqual(len(history.json()["history"]), 4)

        self.client.patch(
            "/api/cells/COM51235/17/details",
            headers={"X-User": quote("테스터")},
            json={"value": "다음 주 사용", "expected_version": 0},
        )
        activity = self.client.get("/api/activity?limit=1")
        self.assertEqual(activity.status_code, 200)
        self.assertEqual(activity.json()["items"][0]["updated_by"], "테스터")

    def test_websocket_receives_updates(self) -> None:
        with self.client.websocket_connect("/ws/updates") as websocket:
            self.assertEqual(websocket.receive_json()["type"], "ready")
            response = self.client.patch(
                "/api/cells/ENG51235/25/details",
                json={"value": "WebSocket 확인", "expected_version": 0},
            )
            self.assertEqual(response.status_code, 200)
            message = websocket.receive_json()
            self.assertEqual(message["type"], "cell_updated")
            self.assertEqual(message["cell"]["value"], "WebSocket 확인")


if __name__ == "__main__":
    unittest.main()
