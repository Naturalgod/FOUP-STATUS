from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


EDITABLE_COLUMNS = ("planned_sub", "assignee", "details")
UNSET = object()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class CellConflict(Exception):
    def __init__(self, current: Dict[str, Any]):
        super().__init__("cell version conflict")
        self.current = current


class UnknownFoup(Exception):
    pass


class Database:
    """SQLite와 PostgreSQL을 같은 저장 계약으로 제공한다.

    로컬에서는 파일 경로나 ``sqlite:///...``를, 운영에서는
    ``postgresql://...`` 또는 ``postgresql+psycopg://...``를 받는다.
    """

    def __init__(self, target: str):
        self.target = target
        self.is_postgres = target.startswith(
            ("postgresql://", "postgres://", "postgresql+psycopg://")
        )
        if self.is_postgres:
            self.dsn = target.replace("postgresql+psycopg://", "postgresql://", 1)
            self.path: Optional[str] = None
        else:
            self.path = (
                target.replace("sqlite:///", "", 1)
                if target.startswith("sqlite:///")
                else target
            )
            self.dsn = None
            if self.path != ":memory:":
                Path(self.path).parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> Any:
        if self.is_postgres:
            try:
                import psycopg
                from psycopg.rows import dict_row
            except ImportError as exc:
                raise RuntimeError(
                    "PostgreSQL 사용에는 psycopg가 필요합니다. requirements.txt를 설치하세요."
                ) from exc
            return psycopg.connect(self.dsn, row_factory=dict_row)

        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def _sql(self, query: str) -> str:
        return query.replace("?", "%s") if self.is_postgres else query

    def _execute(self, connection: Any, query: str, params: Iterable[Any] = ()) -> Any:
        return connection.execute(self._sql(query), tuple(params))

    def _executemany(
        self, connection: Any, query: str, rows: Iterable[Iterable[Any]]
    ) -> Any:
        if self.is_postgres:
            with connection.cursor() as cursor:
                return cursor.executemany(self._sql(query), rows)
        return connection.executemany(self._sql(query), rows)

    def _begin_write(self, connection: Any) -> None:
        if not self.is_postgres:
            connection.execute("BEGIN IMMEDIATE")

    def initialize(self) -> None:
        common_schema = """
            CREATE TABLE IF NOT EXISTS foups (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                owner TEXT NOT NULL,
                total_slots INTEGER NOT NULL DEFAULT 25,
                header_color TEXT NOT NULL,
                display_order INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS plan_cells (
                foup_id TEXT NOT NULL REFERENCES foups(id) ON DELETE CASCADE,
                slot_no INTEGER NOT NULL CHECK(slot_no BETWEEN 1 AND 25),
                column_key TEXT NOT NULL CHECK(column_key IN ('planned_sub', 'assignee', 'details')),
                value TEXT NOT NULL DEFAULT '',
                color TEXT,
                version INTEGER NOT NULL DEFAULT 0,
                updated_by TEXT NOT NULL DEFAULT 'system',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (foup_id, slot_no, column_key)
            );
        """
        history_schema = (
            """
            CREATE TABLE IF NOT EXISTS cell_history (
                id BIGSERIAL PRIMARY KEY,
                foup_id TEXT NOT NULL,
                slot_no INTEGER NOT NULL,
                column_key TEXT NOT NULL,
                old_value TEXT NOT NULL,
                new_value TEXT NOT NULL,
                old_color TEXT,
                new_color TEXT,
                updated_by TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
            if self.is_postgres
            else
            """
            CREATE TABLE IF NOT EXISTS cell_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                foup_id TEXT NOT NULL,
                slot_no INTEGER NOT NULL,
                column_key TEXT NOT NULL,
                old_value TEXT NOT NULL,
                new_value TEXT NOT NULL,
                old_color TEXT,
                new_color TEXT,
                updated_by TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        index_schema = """
            CREATE INDEX IF NOT EXISTS idx_cell_history_updated_at
            ON cell_history(updated_at DESC);
        """

        with self.connect() as connection:
            if self.is_postgres:
                for statement in (common_schema, history_schema, index_schema):
                    self._execute(connection, statement)
            else:
                connection.executescript(common_schema + history_schema + index_schema)

            count_row = self._execute(
                connection, "SELECT COUNT(*) AS row_count FROM foups"
            ).fetchone()
            count = count_row["row_count"] if self.is_postgres else count_row[0]
            if count == 0:
                self._seed(connection)

    def _seed(self, connection: Any) -> None:
        now = utc_now()
        foups = [
            ("ENG10000", "Metal", "Storage", 25, "#FCE5CD", 1),
            ("ENG20002", "Metal", "Storage", 25, "#EA9999", 2),
            ("COM51235", "Metal", "Storage", 25, "#D9D2E9", 3),
            ("ENG51235", "Metal", "Storage", 25, "#FFE599", 4),
        ]
        self._executemany(
            connection,
            """
            INSERT INTO foups(id, category, owner, total_slots, header_color, display_order)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            foups,
        )

        initial: Dict[str, Dict[int, Dict[str, str]]] = {
            "ENG10000": {
                slot: {
                    "planned_sub": "RECLAIM" if slot <= 4 else "TH-OX",
                    "assignee": "김철수",
                    "details": "SiCO 평가",
                }
                for slot in range(1, 11)
            },
            "ENG20002": {
                slot: {
                    "planned_sub": "R7QAA03.{:02d}".format(slot),
                    "assignee": "이순신",
                    "details": (
                        "ALD W 120" if slot <= 3 else "PNL XT" if slot <= 6 else "PNL"
                    ),
                }
                for slot in range(1, 11)
            },
            "COM51235": {
                slot: {
                    "planned_sub": "TEST2",
                    "assignee": "세종",
                    "details": "PTCL 평가",
                }
                for slot in range(1, 17)
            },
            "ENG51235": {
                slot: {
                    "planned_sub": "DEMO",
                    "assignee": "오박사",
                    "details": "DEMO 평가 대기",
                }
                for slot in range(1, 23)
            },
        }

        records = []
        for foup_id, _, _, total_slots, _, _ in foups:
            for slot_no in range(1, total_slots + 1):
                seeded = initial.get(foup_id, {}).get(slot_no, {})
                for column_key in EDITABLE_COLUMNS:
                    records.append(
                        (
                            foup_id,
                            slot_no,
                            column_key,
                            seeded.get(column_key, ""),
                            None,
                            0,
                            "Google Sheet 초기 데이터",
                            now,
                        )
                    )
        self._executemany(
            connection,
            """
            INSERT INTO plan_cells(
                foup_id, slot_no, column_key, value, color, version, updated_by, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            records,
        )

    def list_foups(self) -> List[Dict[str, Any]]:
        with self.connect() as connection:
            rows = self._execute(
                connection, "SELECT * FROM foups ORDER BY display_order, id"
            ).fetchall()
        return [dict(row) for row in rows]

    def list_cells(
        self, foup_ids: Optional[Iterable[str]] = None
    ) -> List[Dict[str, Any]]:
        with self.connect() as connection:
            if foup_ids:
                ids = list(foup_ids)
                placeholders = ",".join(self._sql("?") for _ in ids)
                query = """
                    SELECT * FROM plan_cells
                    WHERE foup_id IN ({})
                    ORDER BY foup_id, slot_no, column_key
                    """.format(placeholders)
                rows = connection.execute(query, ids).fetchall()
            else:
                rows = self._execute(
                    connection,
                    "SELECT * FROM plan_cells ORDER BY foup_id, slot_no, column_key",
                ).fetchall()
        return [dict(row) for row in rows]

    @staticmethod
    def _row_to_cell(
        row: Optional[Any], foup_id: str, slot_no: int, column_key: str
    ) -> Dict[str, Any]:
        if row is None:
            return {
                "foup_id": foup_id,
                "slot_no": slot_no,
                "column_key": column_key,
                "value": "",
                "color": None,
                "version": 0,
                "updated_by": "system",
                "updated_at": utc_now(),
            }
        return dict(row)

    def _assert_foup(self, connection: Any, foup_id: str) -> None:
        exists = self._execute(
            connection, "SELECT 1 FROM foups WHERE id = ?", (foup_id,)
        ).fetchone()
        if exists is None:
            raise UnknownFoup(foup_id)

    def _apply_update(
        self,
        connection: Any,
        *,
        foup_id: str,
        slot_no: int,
        column_key: str,
        value: Any = UNSET,
        color: Any = UNSET,
        expected_version: Optional[int] = None,
        updated_by: str,
    ) -> Dict[str, Any]:
        self._assert_foup(connection, foup_id)
        lock_clause = " FOR UPDATE" if self.is_postgres else ""
        row = self._execute(
            connection,
            """
            SELECT * FROM plan_cells
            WHERE foup_id = ? AND slot_no = ? AND column_key = ?
            """ + lock_clause,
            (foup_id, slot_no, column_key),
        ).fetchone()
        current = self._row_to_cell(row, foup_id, slot_no, column_key)
        if expected_version is not None and expected_version != current["version"]:
            raise CellConflict(current)

        next_value = (
            current["value"] if value is UNSET else ("" if value is None else str(value))
        )
        next_color = current["color"] if color is UNSET else color
        next_version = current["version"] + 1
        now = utc_now()

        self._execute(
            connection,
            """
            INSERT INTO plan_cells(
                foup_id, slot_no, column_key, value, color, version, updated_by, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(foup_id, slot_no, column_key) DO UPDATE SET
                value = excluded.value,
                color = excluded.color,
                version = excluded.version,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at
            """,
            (
                foup_id,
                slot_no,
                column_key,
                next_value,
                next_color,
                next_version,
                updated_by,
                now,
            ),
        )
        self._execute(
            connection,
            """
            INSERT INTO cell_history(
                foup_id, slot_no, column_key, old_value, new_value,
                old_color, new_color, updated_by, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                foup_id,
                slot_no,
                column_key,
                current["value"],
                next_value,
                current["color"],
                next_color,
                updated_by,
                now,
            ),
        )
        return {
            "foup_id": foup_id,
            "slot_no": slot_no,
            "column_key": column_key,
            "value": next_value,
            "color": next_color,
            "version": next_version,
            "updated_by": updated_by,
            "updated_at": now,
        }

    def update_cell(self, **kwargs: Any) -> Dict[str, Any]:
        with self.connect() as connection:
            self._begin_write(connection)
            result = self._apply_update(connection, **kwargs)
            connection.commit()
        return result

    def batch_update(
        self, updates: List[Dict[str, Any]], updated_by: str
    ) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        with self.connect() as connection:
            self._begin_write(connection)
            for update in updates:
                results.append(
                    self._apply_update(connection, updated_by=updated_by, **update)
                )
            connection.commit()
        return results

    def recent_activity(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self.connect() as connection:
            rows = self._execute(
                connection,
                """
                SELECT * FROM cell_history
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]
