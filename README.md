# FOUP Control Sheet

기존 Google Sheet의 2×2 FOUP 배치와 25 Slot 입력 방식을 유지하면서, 사내 실시간 FOUP/Wafer 정보와 사용 계획을 함께 보여주는 FastAPI 앱입니다. 별도 프론트엔드 빌드 서버 없이 FastAPI 한 프로세스가 API와 화면을 함께 서빙합니다.

## 구현 범위

- `Sub / 사용자 / 세부사항` 셀 직접 편집 및 자동 저장
- 편집 전 사용자 이름 필수 입력 및 모든 수정·삭제·복원 이력에 편집자 기록
- 기본 `계획 시트` 보기에서 기존 Google Sheet의 `Slot / Sub / 사용자 / 세부사항` 구조 유지
- `실시간 통합` 보기에서 현재 Wafer와 현재 Step 열을 함께 확인
- Shift 범위 선택, Ctrl/⌘ 다중 선택, 다중 셀 복사·붙여넣기·삭제
- 선택 셀 배경색 지정·삭제(향후 사용 예약 표시)
- Ctrl/⌘+Z 및 상단 버튼으로 마지막 단일·다중 셀 작업 되돌리기
- 셀별 변경 이력 확인과 원하는 변경 전 상태 복원
- FOUP 위치, Slot별 현재 Wafer, 현재 Step 표시
- Wafer 클릭 시 공정 History 패널 표시
- WebSocket 기반 다중 사용자 실시간 갱신
- 셀 버전 기반 동시 수정 충돌 방지와 변경 이력 저장
- 작업 묶음 ID 기반 일괄 복원과 이후 수정 감지 시 안전 차단
- PostgreSQL 운영 지원, SQLite 로컬 데모 지원
- 사내 실시간 API 장애 시에도 계획 편집은 계속 가능한 분리 구조

## Windows 사내 PC 실행

Python 3.9 이상 64비트 버전을 설치한 뒤 프로젝트 폴더에서 다음 파일을 순서대로 실행합니다.

```bat
setup_windows.cmd
start_windows.cmd
```

`setup_windows.cmd`는 Windows용 가상환경과 패키지를 준비하며 최초 한 번만 실행하면 됩니다. `start_windows.cmd`는 기본적으로 `0.0.0.0:8000`에서 FastAPI를 실행합니다. 브라우저에서 `http://127.0.0.1:8000`으로 접속하고, 같은 사내망의 다른 PC에서는 방화벽과 사내 정책이 허용된 경우 `http://서버PC주소:8000`으로 접속합니다.

운영 설정이 필요하면 `.env.example`을 `.env`로 복사해 값을 수정합니다. Windows 탐색기에서 확장자가 숨겨진 경우 파일명이 `.env.txt`가 되지 않도록 확인하세요. 사내 패키지 저장소나 프록시를 사용하는 환경에서는 `PIP_INDEX_URL`, `HTTPS_PROXY`를 회사 기준에 맞게 설정한 뒤 `setup_windows.cmd`를 실행합니다.

포트를 변경하려면 명령 프롬프트에서 아래처럼 실행합니다.

```bat
set FOUP_PORT=8765
start_windows.cmd
```

## macOS/Linux 개발 실행

Python 3.9 이상에서 실행합니다.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

브라우저에서 `http://127.0.0.1:8000`으로 접속합니다. API 문서는 `http://127.0.0.1:8000/api/docs`입니다. 환경 변수가 없으면 `data/foup_manager.db`와 데모 실시간 데이터를 사용합니다.

> `app/static/index.html`을 Windows 탐색기나 Finder에서 직접 열면 API가 연결되지 않습니다. 반드시 FastAPI를 실행하고 `http://127.0.0.1:8000`으로 접속하세요.

## PostgreSQL 연결

운영 서버에 아래 환경 변수를 지정하면 SQLite 대신 PostgreSQL을 사용합니다. 앱 시작 시 `foups`, `plan_cells`, `cell_history` 테이블과 인덱스를 생성하고, 빈 DB에는 현재 Google Sheet의 네 FOUP를 초기 데이터로 넣습니다.

Windows에서는 `.env.example`을 `.env`로 복사한 뒤 `DATABASE_URL`을 수정하면 `start_windows.cmd`가 자동으로 읽습니다.

```bash
export DATABASE_URL='postgresql+psycopg://USER:PASSWORD@DB_HOST:5432/DB_NAME'
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

로컬 PostgreSQL까지 한 번에 확인하려면 다음 명령을 사용합니다.

```bash
docker compose up --build
```

## 사내 실시간 데이터 연동

`app/live_data.py`의 `HttpLiveDataAdapter`는 아래 계약을 사용합니다.

### FOUP Snapshot

`GET {FOUP_LIVE_API_URL}/foups/snapshot?ids=ENG10000,ENG20002`

```json
{
  "foups": [
    {
      "foup_id": "ENG10000",
      "location": "FAB 1 · STK-03",
      "location_type": "STOCKER",
      "status": "ONLINE",
      "synced_at": "2026-09-17T09:00:00+00:00",
      "slots": [
        {
          "slot_no": 1,
          "wafer_id": "R7QAA03.01",
          "current_step": "ALD W 120",
          "last_process": "PASS",
          "history_count": 4
        }
      ]
    }
  ]
}
```

### Wafer History

`GET {FOUP_LIVE_API_URL}/foups/{foup_id}/slots/{slot_no}/history`

```json
{
  "foup_id": "ENG10000",
  "slot_no": 1,
  "wafer_id": "R7QAA03.01",
  "history": [
    {
      "timestamp": "2026-09-17T08:40:00+00:00",
      "step": "PRE CLEAN",
      "tool": "CLN-14",
      "result": "PASS"
    }
  ]
}
```

연결 설정:

```bash
export FOUP_LIVE_API_URL='https://internal-api.example'
export FOUP_LIVE_API_TOKEN='replace-with-service-token'
export FOUP_LIVE_API_TIMEOUT='5'
```

사내 응답 형식이 다르면 `HttpLiveDataAdapter` 내부의 두 메서드에서 회사 스키마를 위 계약으로 변환하면 됩니다. 토큰은 브라우저로 전달되지 않습니다.

## HCP 배포 준비

사내 HCP에 맞춘 이미지, Windows 서비스, Kubernetes 배포 파일, 인증 연동, Secret 주입과 다중 인스턴스 WebSocket 구성이 필요하면 [HCP 배포 환경 확인 항목](docs/HCP_DEPLOYMENT_CHECKLIST.md)을 기준으로 환경 정보를 정리합니다. 비밀번호나 실제 토큰은 전달하지 않고 주입 방식과 비식별 샘플만 공유합니다.

## 검증

```bash
python3 -m unittest discover -s tests -v
```

운영 배포 전에는 사내 인증 프록시/SSO에서 사용자 이름을 검증하고, 현재 화면이 보내는 `X-User`를 신뢰 가능한 사내 사용자 정보로 치환해야 합니다.
셀 수정 API는 `X-User`가 비어 있거나 `익명 사용자`이면 요청을 거부합니다.
