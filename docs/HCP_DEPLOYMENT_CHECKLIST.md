# HCP 배포 환경 확인 항목

아래 항목을 확인하면 FOUP 앱을 사내 HCP 배포 방식에 맞게 구성할 수 있습니다. 비밀번호, 토큰, 인증서 원문은 공유하지 말고 주입 방식과 샘플 형식만 전달합니다.

## 1. 플랫폼과 실행 환경

- HCP의 정확한 제품명, 사내 서비스명, 버전
- 실행 OS: Windows Server 또는 Linux와 버전
- 배포 단위: Windows 서비스, VM 프로세스, Docker/Podman 컨테이너, Kubernetes 중 해당 방식
- Python 직접 실행 허용 여부와 지원 버전
- 외부 인터넷 차단 여부, 사내 PyPI/컨테이너 레지스트리 주소 사용 방식
- 애플리케이션이 쓸 수 있는 CPU, 메모리, 임시·영구 디스크 용량

## 2. 네트워크와 접속 주소

- 사용자 접속용 내부 도메인과 기본 경로 예시
- 앱이 수신해야 하는 내부 포트
- IIS, Nginx, 사내 Ingress 등 앞단 프록시 종류
- TLS 종료 위치와 사내 CA 인증서 설치 방식
- WebSocket 업그레이드 허용 여부와 idle timeout
- 외부 API 호출용 HTTP/HTTPS 프록시 및 방화벽 허용 절차

## 3. PostgreSQL

- PostgreSQL 버전, 호스트, 포트, DB명, 스키마명
- SSL 필수 여부와 `sslmode`, 사내 CA 적용 방식
- 계정·비밀번호 또는 Secret을 애플리케이션에 주입하는 방식
- 연결 수 제한, connection pool 기준, DB 이중화·Failover 방식
- 테이블 자동 생성 권한 허용 여부와 별도 DDL 배포 필요 여부

## 4. 사용자 인증과 권한

- AD, 사내 SSO, OAuth/OIDC, 인증 프록시 중 사용 방식
- 인증 후 앱에 전달되는 사용자 ID·이름·부서 헤더의 이름과 샘플
- 일반 편집자, 조회자, 관리자 구분 필요 여부
- 셀 복원과 전체 변경 이력 조회 권한 기준

현재 화면의 편집자 이름은 사용자가 직접 입력합니다. 운영 HCP에서 인증 사용자 헤더를 제공하면 해당 값을 서버에서 신뢰하고, 편집자 입력칸은 읽기 전용 표시로 바꾸는 방식이 더 안전합니다.

## 5. FOUP 실시간 API

- Snapshot과 Wafer History API의 비식별 샘플 JSON
- 인증 방식: Bearer token, mTLS, API key, 사내 SSO 등
- 호출 주기·rate limit·timeout·재시도 기준
- FOUP ID, Slot 번호, Wafer ID, 위치, Step, History 필드 정의
- 장애·부분 응답·데이터 지연 시 기대 동작

## 6. 운영 방식

- 단일 인스턴스 또는 다중 인스턴스와 예상 사용자 수
- 로그 수집 위치와 형식, 보관 기간, 개인정보 마스킹 기준
- `/api/health`를 사용할 HCP health check 규칙
- 배포·롤백 방식과 무중단 배포 필요 여부
- DB 백업·복구 및 변경 이력 보관 기간
- 서버 표준 시간대와 감사 로그 시각 기준

다중 인스턴스로 실행하면 현재 프로세스 메모리에 있는 WebSocket 브로드캐스트를 Redis Pub/Sub 또는 PostgreSQL LISTEN/NOTIFY 기반으로 바꿔야 모든 사용자 화면에 동일한 실시간 변경이 전달됩니다.
