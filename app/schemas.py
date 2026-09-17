from typing import List, Literal, Optional

from pydantic import BaseModel, Field


ColumnKey = Literal["planned_sub", "assignee", "details"]


class CellPatch(BaseModel):
    value: Optional[str] = Field(default=None, max_length=500)
    color: Optional[str] = None
    expected_version: Optional[int] = Field(default=None, ge=0)


class BatchCellPatch(CellPatch):
    foup_id: str = Field(min_length=1, max_length=64)
    slot_no: int = Field(ge=1, le=25)
    column_key: ColumnKey


class BatchPatchRequest(BaseModel):
    updates: List[BatchCellPatch] = Field(min_length=1, max_length=500)

